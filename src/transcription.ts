import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { WAMessage, WASocket } from '@whiskeysockets/baileys';

import { readEnvFile } from './env.js';

interface TranscriptionConfig {
  model: string;
  enabled: boolean;
  fallbackMessage: string;
}

const DEFAULT_CONFIG: TranscriptionConfig = {
  model: 'whisper-1',
  enabled: true,
  fallbackMessage: '[Voice Message - transcription unavailable]',
};

async function transcribeAudio(
  audioBuffer: Buffer,
  config: TranscriptionConfig,
): Promise<string | null> {
  const env = readEnvFile(['OPENAI_API_KEY', 'GROQ_API_KEY']);
  const groqKey = env.GROQ_API_KEY;
  const openaiKey = env.OPENAI_API_KEY;

  // Prefer Groq (faster, cheaper), fall back to OpenAI
  const apiKey = groqKey || openaiKey;
  const baseURL = groqKey
    ? 'https://api.groq.com/openai/v1'
    : undefined;
  const model = groqKey ? 'whisper-large-v3-turbo' : config.model;

  if (!apiKey) {
    console.warn('Neither GROQ_API_KEY nor OPENAI_API_KEY set in .env');
    return null;
  }

  try {
    const openaiModule = await import('openai');
    const OpenAI = openaiModule.default;
    const toFile = openaiModule.toFile;

    const client = new OpenAI({ apiKey, baseURL });

    const file = await toFile(audioBuffer, 'voice.ogg', {
      type: 'audio/ogg',
    });

    const transcription = await client.audio.transcriptions.create({
      file: file,
      model,
      response_format: 'text',
    });

    // When response_format is 'text', the API returns a plain string
    return transcription as unknown as string;
  } catch (err) {
    console.error('Transcription failed:', err);
    return null;
  }
}

export async function transcribeAudioMessage(
  msg: WAMessage,
  sock: WASocket,
): Promise<string | null> {
  const config = DEFAULT_CONFIG;

  if (!config.enabled) {
    return config.fallbackMessage;
  }

  try {
    const buffer = (await downloadMediaMessage(
      msg,
      'buffer',
      {},
      {
        logger: console as any,
        reuploadRequest: sock.updateMediaMessage,
      },
    )) as Buffer;

    if (!buffer || buffer.length === 0) {
      console.error('Failed to download audio message');
      return config.fallbackMessage;
    }

    console.log(`Downloaded audio message: ${buffer.length} bytes`);

    const transcript = await transcribeAudio(buffer, config);

    if (!transcript) {
      return config.fallbackMessage;
    }

    return transcript.trim();
  } catch (err) {
    console.error('Transcription error:', err);
    return config.fallbackMessage;
  }
}

export function isVoiceMessage(msg: WAMessage): boolean {
  return msg.message?.audioMessage?.ptt === true;
}
