/**
 * iMessage Channel for NanoClaw
 *
 * Reads incoming messages by polling ~/Library/Messages/chat.db (macOS only).
 * Sends outbound messages via AppleScript (Messages.app).
 *
 * JID format: "imsg:{chat_identifier}" — matches the chat_identifier column
 * in the macOS Messages database. For 1:1 chats this is the handle (email/phone),
 * for group chats it's the chat guid (e.g., "chat28677937245284478").
 */
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import os from 'os';
import path from 'path';

import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const IMESSAGE_PREFIX = 'imsg:';
const CHAT_DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
const POLL_INTERVAL = 2000; // 2 seconds

// Apple's cocoa epoch: 2001-01-01 00:00:00 UTC in unix seconds
const COCOA_EPOCH_OFFSET = 978307200;

function cocoaNanosToISO(cocoaNanos: number): string {
  const unixMs = (cocoaNanos / 1_000_000_000 + COCOA_EPOCH_OFFSET) * 1000;
  return new Date(unixMs).toISOString();
}

function nowAsCocoaNanos(): number {
  return (Date.now() / 1000 - COCOA_EPOCH_OFFSET) * 1_000_000_000;
}

export class IMessageChannel implements Channel {
  name = 'imessage';

  private opts: ChannelOpts;
  private db!: Database.Database;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastPollDate: number = 0; // cocoa nanoseconds
  private connected_ = false;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (process.platform !== 'darwin') {
      logger.warn('iMessage channel is macOS-only, skipping');
      return;
    }

    try {
      this.db = new Database(CHAT_DB_PATH, { readonly: true });
    } catch (err) {
      logger.error(
        { err },
        'Failed to open iMessage database. Grant Full Disk Access to node.',
      );
      return;
    }

    // Start polling from now (don't replay old messages)
    this.lastPollDate = nowAsCocoaNanos();
    this.connected_ = true;

    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL);

    // Emit metadata for registered chats
    this.syncChatMetadata();

    logger.info('iMessage channel connected');
  }

  private syncChatMetadata(): void {
    const groups = this.opts.registeredGroups();
    for (const [jid, group] of Object.entries(groups)) {
      if (!jid.startsWith(IMESSAGE_PREFIX)) continue;
      const chatId = jid.slice(IMESSAGE_PREFIX.length);

      const row = this.db
        .prepare(
          `SELECT c.display_name, c.style,
                  (SELECT MAX(m.date) FROM chat_message_join cmj
                   JOIN message m ON cmj.message_id = m.ROWID
                   WHERE cmj.chat_id = c.ROWID) as last_date
           FROM chat c WHERE c.chat_identifier = ?`,
        )
        .get(chatId) as
        | { display_name: string | null; style: number; last_date: number | null }
        | undefined;

      if (row) {
        const ts = row.last_date ? cocoaNanosToISO(row.last_date) : new Date().toISOString();
        const isGroup = row.style === 43;
        this.opts.onChatMetadata(
          jid,
          ts,
          row.display_name || group.name,
          'imessage',
          isGroup,
        );
      }
    }
  }

  private poll(): void {
    try {
      const rows = this.db
        .prepare(
          `SELECT m.ROWID, m.guid, m.text, m.date, m.is_from_me,
                  m.attributedBody, m.is_system_message,
                  h.id as sender_id,
                  c.chat_identifier, c.display_name, c.style
           FROM message m
           JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
           JOIN chat c ON cmj.chat_id = c.ROWID
           LEFT JOIN handle h ON m.handle_id = h.ROWID
           WHERE m.date > ?
             AND m.is_system_message = 0
             AND m.item_type = 0
             AND c.service_name IN ('iMessage', 'RCS')
           ORDER BY m.date ASC`,
        )
        .all(this.lastPollDate) as Array<{
        ROWID: number;
        guid: string;
        text: string | null;
        date: number;
        is_from_me: number;
        attributedBody: Buffer | null;
        is_system_message: number;
        sender_id: string | null;
        chat_identifier: string;
        display_name: string | null;
        style: number;
      }>;

      for (const row of rows) {
        this.lastPollDate = row.date;

        // Extract text — sometimes text is null but attributedBody has it
        let text = row.text;
        if (!text && row.attributedBody) {
          text = extractTextFromAttributedBody(row.attributedBody);
        }
        if (!text) continue;

        const jid = `${IMESSAGE_PREFIX}${row.chat_identifier}`;
        const isGroup = row.style === 43;
        const timestamp = cocoaNanosToISO(row.date);

        // Emit chat metadata
        this.opts.onChatMetadata(
          jid,
          timestamp,
          row.display_name || row.chat_identifier,
          'imessage',
          isGroup,
        );

        // Determine sender name
        const senderId = row.is_from_me ? 'me' : (row.sender_id || 'unknown');
        const senderName = row.is_from_me ? 'Me' : friendlyName(row.sender_id);

        this.opts.onMessage(jid, {
          id: row.guid,
          chat_jid: jid,
          sender: senderId,
          sender_name: senderName,
          content: text,
          timestamp,
          is_from_me: row.is_from_me === 1,
        });
      }
    } catch (err) {
      logger.error({ err }, 'iMessage poll error');
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = jid.slice(IMESSAGE_PREFIX.length);
    const groups = this.opts.registeredGroups();
    const group = groups[jid];
    const displayName = group?.assistantName || 'Claude';

    // Prefix with assistant name (like WhatsApp channel)
    const prefixed = `${displayName}: ${text}`;

    // Escape for AppleScript
    const escaped = prefixed
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n');

    // Determine if this is a group chat (chat identifier starts with "chat")
    const isGroupChat = chatId.startsWith('chat');

    let script: string;
    if (isGroupChat) {
      // For group chats, send to the chat directly
      script = `tell application "Messages"
  set targetChat to a reference to text chat id "${chatId}"
  send "${escaped}" to targetChat
end tell`;
    } else {
      // For 1:1 chats, send to buddy via iMessage service
      script = `tell application "Messages"
  set targetService to 1st service whose service type = iMessage
  set targetBuddy to buddy "${chatId}" of targetService
  send "${escaped}" to targetBuddy
end tell`;
    }

    try {
      execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
        timeout: 10_000,
      });
      logger.info({ jid, length: prefixed.length }, 'iMessage sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send iMessage');
      throw err;
    }
  }

  isConnected(): boolean {
    return this.connected_;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(IMESSAGE_PREFIX);
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.db) {
      this.db.close();
    }
    this.connected_ = false;
    logger.info('iMessage channel disconnected');
  }
}

/**
 * Extract text from NSAttributedString binary blob.
 * Messages.app sometimes stores text only in attributedBody.
 */
function extractTextFromAttributedBody(blob: Buffer): string | null {
  try {
    // The text is usually stored as a UTF-8 string after a specific marker
    const str = blob.toString('utf-8');
    // Look for the streamtyped marker pattern then extract the string after it
    const marker = 'NSString';
    const idx = str.indexOf(marker);
    if (idx === -1) return null;

    // After NSString marker, find the actual text content
    // The format has length bytes followed by the text
    const afterMarker = str.slice(idx + marker.length);
    // Find printable text — skip control characters
    const match = afterMarker.match(/[\x20-\x7E\u00A0-\uFFFF]+/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

/**
 * Convert an iMessage handle (email/phone) to a friendly display name.
 */
function friendlyName(handle: string | null): string {
  if (!handle) return 'Unknown';
  // If it's an email, use the part before @
  if (handle.includes('@')) {
    return handle.split('@')[0];
  }
  return handle;
}

// Self-register
registerChannel('imessage', (opts: ChannelOpts) => {
  if (process.platform !== 'darwin') return null;

  // Check if any registered groups use imessage
  const groups = opts.registeredGroups();
  const hasImessageGroups = Object.keys(groups).some((jid) =>
    jid.startsWith(IMESSAGE_PREFIX),
  );

  if (!hasImessageGroups) {
    logger.debug('No iMessage groups registered, skipping channel');
    return null;
  }

  return new IMessageChannel(opts);
});
