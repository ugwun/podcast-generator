import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

export const config = {
  root,
  port: Number(process.env.PORT ?? 5180),
  dataDir: process.env.PODCAST_DATA_DIR ?? join(root, 'data'),
  webDir: join(root, 'web/dist'),
  writerWorkspace: join(root, 'writer-workspace'),
  t3RuntimeFile: process.env.T3_RUNTIME_FILE ?? join(homedir(), '.t3/userdata/server-runtime.json'),
  t3RunTimeoutMs: Number(process.env.T3_RUN_TIMEOUT_MS ?? 15 * 60_000),
  elevenLabsKeyFile: process.env.ELEVENLABS_KEY_FILE ?? join(homedir(), '.config/podcast-generator/elevenlabs.env'),
  elevenLabsBaseUrl: process.env.ELEVENLABS_BASE_URL ?? 'https://api.elevenlabs.io',
  elevenLabsModel: process.env.ELEVENLABS_MODEL ?? 'eleven_v4',
  elevenLabsTimeoutMs: Number(process.env.ELEVENLABS_TIMEOUT_MS ?? 180_000),
  outputFormat: 'mp3_44100_128',
  maxUploadBytes: 50 * 1024 * 1024,
  // T3 rejects a first message above 120k characters.
  promptSourceChars: 100_000,
  condenseChunkChars: 90_000,
  maxSourceChars: 1_000_000,
};
