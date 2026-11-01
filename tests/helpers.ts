import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// config.ts reads the environment on import, so this file must be imported before any server module.
export const dataDir = mkdtempSync(join(tmpdir(), 'podcast-test-'));
process.env.PODCAST_DATA_DIR = dataDir;
process.env.ELEVENLABS_API_KEY = 'test-key';
// Nothing listens here: no test may ever reach the real, billed API.
process.env.ELEVENLABS_BASE_URL = 'http://127.0.0.1:9';
process.env.ELEVENLABS_KEY_FILE = join(dataDir, 'missing.env');

const fakeBin = join(dataDir, 'fake-t3.mjs');
export const t3Log = join(dataDir, 't3-calls.jsonl');
writeFileSync(
  fakeBin,
  `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const stdin = args.includes('-') ? readFileSync(0, 'utf8') : '';
appendFileSync(${JSON.stringify(t3Log)}, JSON.stringify({ args, stdin }) + '\\n');
if (args[1] === 'list') {
  console.log(JSON.stringify([{ threadId: 'thread-1', providerInstanceId: process.env.FAKE_T3_PROVIDER || 'claudeAgent' }]));
  process.exit(0);
}
const queue = JSON.parse(process.env.FAKE_T3_REPLIES || '[]');
const calls = readFileSync(${JSON.stringify(t3Log)}, 'utf8').trim().split('\\n').filter((line) => JSON.parse(line).args[1] !== 'list').length;
const reply = queue[Math.min(calls, queue.length) - 1] ?? 'TITLE: x\\nSUMMARY: y\\n---\\nA: ahoj\\nB: cau';
console.log(JSON.stringify({ threadId: 'thread-1', runId: 'run-1', status: 'completed', reply, error: null }));
`,
  { mode: 0o755 },
);
process.env.T3_BIN = fakeBin;

export function fakeScriptReply(chars: number): string {
  const turn = 'Toto je veta, ktoru hovori moderator v rozhovore o teme, a ma presne tolko znakov, kolko treba.';
  const count = Math.ceil(chars / turn.length);
  const lines = Array.from({ length: count }, (_, index) => `${index % 2 ? 'B' : 'A'}: ${turn}`);
  return `TITLE: Skusobna epizoda\nSUMMARY: Popis\n---\n${lines.join('\n')}`;
}
