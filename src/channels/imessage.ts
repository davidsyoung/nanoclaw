/**
 * iMessage Channel for NanoClaw
 *
 * Reads incoming messages by polling ~/Library/Messages/chat.db (macOS only).
 * Sends outbound messages via AppleScript (Messages.app).
 * Supports image attachments (HEIC/JPEG/PNG) and voice message transcription.
 *
 * JID format: "imsg:{chat_identifier}" — matches the chat_identifier column
 * in the macOS Messages database. For 1:1 chats this is the handle (email/phone),
 * for group chats it's the chat guid (e.g., "chat28677937245284478").
 */
import { execSync } from 'child_process';
import fs from 'fs';
import Database from 'better-sqlite3';
import os from 'os';
import path from 'path';

import { logger } from '../logger.js';
import { transcribeAudio } from '../transcription.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const IMESSAGE_PREFIX = 'imsg:';
const CHAT_DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
const POLL_INTERVAL = 2000;

// Apple's cocoa epoch: 2001-01-01 00:00:00 UTC in unix seconds
const COCOA_EPOCH_OFFSET = 978307200;

function cocoaNanosToISO(cocoaNanos: number): string {
  const unixMs = (cocoaNanos / 1_000_000_000 + COCOA_EPOCH_OFFSET) * 1000;
  return new Date(unixMs).toISOString();
}

function nowAsCocoaNanos(): number {
  return (Date.now() / 1000 - COCOA_EPOCH_OFFSET) * 1_000_000_000;
}

interface MessageRow {
  ROWID: number;
  guid: string;
  text: string | null;
  date: number;
  is_from_me: number;
  attributedBody: Buffer | null;
  cache_has_attachments: number;
  sender_id: string | null;
  chat_identifier: string;
  display_name: string | null;
  style: number;
}

interface AttachmentRow {
  filename: string | null;
  mime_type: string | null;
}

export class IMessageChannel implements Channel {
  name = 'imessage';

  private opts: ChannelOpts;
  private db!: Database.Database;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPollDate: number = 0;
  private connected_ = false;
  private polling = false;

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

    this.lastPollDate = nowAsCocoaNanos();
    this.connected_ = true;
    this.schedulePoll();
    this.syncChatMetadata();
    logger.info('iMessage channel connected');
  }

  private schedulePoll(): void {
    this.pollTimer = setTimeout(() => this.poll(), POLL_INTERVAL);
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
        | {
            display_name: string | null;
            style: number;
            last_date: number | null;
          }
        | undefined;

      if (row) {
        const ts = row.last_date
          ? cocoaNanosToISO(row.last_date)
          : new Date().toISOString();
        this.opts.onChatMetadata(
          jid,
          ts,
          row.display_name || group.name,
          'imessage',
          row.style === 43,
        );
      }
    }
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;

    try {
      const rows = this.db
        .prepare(
          `SELECT m.ROWID, m.guid, m.text, m.date, m.is_from_me,
                  m.attributedBody, m.cache_has_attachments,
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
        .all(this.lastPollDate) as MessageRow[];

      for (const row of rows) {
        this.lastPollDate = row.date;

        const jid = `${IMESSAGE_PREFIX}${row.chat_identifier}`;
        const timestamp = cocoaNanosToISO(row.date);

        this.opts.onChatMetadata(
          jid,
          timestamp,
          row.display_name || row.chat_identifier,
          'imessage',
          row.style === 43,
        );

        // Extract text
        let text = row.text;
        if (!text && row.attributedBody) {
          text = extractTextFromAttributedBody(row.attributedBody);
        }

        // Process attachments (images, audio)
        if (row.cache_has_attachments) {
          const attachmentContent = await this.processAttachments(
            row.ROWID,
            jid,
          );
          if (attachmentContent) {
            text = text ? `${text}\n${attachmentContent}` : attachmentContent;
          }
        }

        if (!text) continue;

        const senderId = row.is_from_me ? 'me' : row.sender_id || 'unknown';
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
    } finally {
      this.polling = false;
      if (this.connected_) this.schedulePoll();
    }
  }

  private async processAttachments(
    messageRowId: number,
    jid: string,
  ): Promise<string | null> {
    const attachments = this.db
      .prepare(
        `SELECT a.filename, a.mime_type
         FROM attachment a
         JOIN message_attachment_join maj ON a.ROWID = maj.attachment_id
         WHERE maj.message_id = ?
           AND a.transfer_state = 5`,
      )
      .all(messageRowId) as AttachmentRow[];

    const parts: string[] = [];

    for (const att of attachments) {
      if (!att.filename || !att.mime_type) continue;

      const filePath = att.filename.startsWith('~/')
        ? path.join(os.homedir(), att.filename.slice(2))
        : att.filename;

      if (!fs.existsSync(filePath)) continue;

      if (att.mime_type.startsWith('image/')) {
        const result = this.processImageAttachment(
          filePath,
          att.mime_type,
          jid,
        );
        if (result) parts.push(result);
      } else if (att.mime_type.startsWith('audio/')) {
        const result = await this.processAudioAttachment(filePath);
        if (result) parts.push(result);
      }
    }

    return parts.length > 0 ? parts.join('\n') : null;
  }

  /**
   * Convert image to JPEG, resize to max 1024px, save to group attachments dir.
   * Uses sips (macOS built-in) for HEIC conversion and resizing.
   */
  private processImageAttachment(
    filePath: string,
    mimeType: string,
    jid: string,
  ): string | null {
    try {
      const group = this.opts.registeredGroups()[jid];
      if (!group) return null;

      const groupDir = resolveGroupFolderPath(group.folder);
      const attachDir = path.join(groupDir, 'attachments');
      fs.mkdirSync(attachDir, { recursive: true });

      const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`;
      const destPath = path.join(attachDir, filename);

      // sips handles HEIC, JPEG, PNG — converts and resizes in one step
      execSync(
        `sips -s format jpeg -Z 1024 "${filePath}" --out "${destPath}" 2>/dev/null`,
        { timeout: 15_000 },
      );

      logger.info({ jid, filename }, 'iMessage image processed');
      return `[Image: attachments/${filename}]`;
    } catch (err) {
      logger.error({ err, filePath }, 'Failed to process image attachment');
      return null;
    }
  }

  /**
   * Convert audio to ogg, transcribe via Groq/OpenAI Whisper.
   */
  private async processAudioAttachment(
    filePath: string,
  ): Promise<string | null> {
    try {
      let audioBuffer: Buffer;

      // iMessage voice notes are .caf; photos/videos can have .m4a audio
      if (
        filePath.endsWith('.caf') ||
        filePath.endsWith('.m4a') ||
        filePath.endsWith('.amr')
      ) {
        const tmpOgg = `/tmp/nanoclaw-audio-${Date.now()}.ogg`;
        try {
          execSync(
            `ffmpeg -i "${filePath}" -c:a libopus -b:a 48k "${tmpOgg}" -y 2>/dev/null`,
            { timeout: 30_000 },
          );
          audioBuffer = fs.readFileSync(tmpOgg);
        } finally {
          try {
            fs.unlinkSync(tmpOgg);
          } catch {
            /* ignore */
          }
        }
      } else {
        audioBuffer = fs.readFileSync(filePath);
      }

      const transcript = await transcribeAudio(audioBuffer, {
        model: 'whisper-1',
        enabled: true,
        fallbackMessage: '[Voice Message - transcription unavailable]',
      });

      if (transcript) {
        logger.info(
          { length: transcript.length },
          'iMessage voice transcribed',
        );
        return `[Voice: ${transcript.trim()}]`;
      }

      return '[Voice Message - transcription unavailable]';
    } catch (err) {
      logger.error({ err, filePath }, 'Failed to process audio attachment');
      return '[Voice Message - processing failed]';
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = jid.slice(IMESSAGE_PREFIX.length);
    const group = this.opts.registeredGroups()[jid];
    const displayName = group?.assistantName || 'Claude';
    const prefixed = `${displayName}: ${text}`;

    const escaped = prefixed
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n');

    const isGroupChat = chatId.startsWith('chat');

    const script = isGroupChat
      ? `tell application "Messages"
  set targetChat to a reference to text chat id "${chatId}"
  send "${escaped}" to targetChat
end tell`
      : `tell application "Messages"
  set targetService to 1st service whose service type = iMessage
  set targetBuddy to buddy "${chatId}" of targetService
  send "${escaped}" to targetBuddy
end tell`;

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
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.connected_ = false;
    if (this.db) this.db.close();
    logger.info('iMessage channel disconnected');
  }
}

function extractTextFromAttributedBody(blob: Buffer): string | null {
  try {
    // NSAttributedString binary format: after "NSString" marker and some type info,
    // there's a length byte (or multi-byte length) followed by the UTF-8 text.
    // The pattern is: ...NSString\x01\x94\x84\x01\x2B{length}{text}...
    const nsStringMarker = Buffer.from('NSString');
    const idx = blob.indexOf(nsStringMarker);
    if (idx === -1) return null;

    // Scan forward from marker to find the \x2B byte ('+' = NSString content marker)
    const searchStart = idx + nsStringMarker.length;
    let pos = searchStart;
    while (pos < blob.length && pos < searchStart + 20) {
      if (blob[pos] === 0x2b) {
        pos++; // skip the 0x2B marker
        // Next byte(s) encode the length
        let textLen = blob[pos];
        pos++;
        if (textLen === 0x81) {
          // Two-byte length: 0x81 followed by actual length byte
          textLen = blob[pos];
          pos++;
        } else if (textLen === 0x82) {
          // Three-byte length: 0x82 followed by 2 big-endian length bytes
          textLen = (blob[pos] << 8) | blob[pos + 1];
          pos += 2;
        }
        if (textLen > 0 && pos + textLen <= blob.length) {
          const text = blob.subarray(pos, pos + textLen).toString('utf-8');
          // Filter out replacement characters from bad decoding
          const clean = text.replace(/\uFFFC/g, '').trim();
          return clean || null;
        }
        break;
      }
      pos++;
    }
    return null;
  } catch {
    return null;
  }
}

function friendlyName(handle: string | null): string {
  if (!handle) return 'Unknown';
  if (handle.includes('@')) return handle.split('@')[0];
  return handle;
}

// Self-register
registerChannel('imessage', (opts: ChannelOpts) => {
  if (process.platform !== 'darwin') return null;

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
