import { spawn } from 'node:child_process';
import { readFile, readlink } from 'node:fs/promises';
import { config } from './config.ts';

export interface ThreadReply {
  threadId: string;
  reply: string;
}

interface CliResult {
  threadId?: string;
  status?: string;
  reply?: string | null;
  error?: string | null;
}

// The binary lives in a hashed runtime folder that changes on every T3 update, so ask the running server for it.
export async function locateT3(): Promise<string> {
  if (process.env.T3_BIN) return process.env.T3_BIN;
  let pid: unknown;
  try {
    ({ pid } = JSON.parse(await readFile(config.t3RuntimeFile, 'utf8')));
  } catch {
    throw new Error('T3 Code nebezi: chyba server-runtime.json.');
  }
  try {
    return await readlink(`/proc/${pid}/exe`);
  } catch {
    throw new Error('T3 Code nebezi: proces servera sa nenasiel.');
  }
}

function runCli(args: string[], stdin = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return locateT3().then(
    (bin) =>
      new Promise((resolve, reject) => {
        const child = spawn(bin, args, { cwd: config.writerWorkspace, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error('T3 agent neodpovedal v casovom limite.'));
        }, config.t3RunTimeoutMs);
        child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
        child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
        child.stdin.on('error', () => {});
        child.stdin.end(stdin);
      }),
  );
}

function parseRun(result: { code: number | null; stdout: string; stderr: string }): ThreadReply {
  let parsed: CliResult = {};
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`T3 vratil neocakavany vystup: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  }
  if (result.code === 2) throw new Error('T3 agent caka na odpoved cloveka, co sa v zamknutom projekte nema stat.');
  if (result.code !== 0 || parsed.status !== 'completed') {
    throw new Error(`T3 agent zlyhal: ${parsed.error ?? parsed.status ?? `kod ${result.code}`}`);
  }
  if (!parsed.threadId || !parsed.reply) throw new Error('T3 agent nevratil ziadny text.');
  return { threadId: parsed.threadId, reply: parsed.reply };
}

export async function startThread(input: { title: string; message: string; model: string }): Promise<ThreadReply> {
  const args = [
    'thread', 'start', config.writerWorkspace, '-',
    '--title', input.title.slice(0, 80),
    '--provider', 'claudeAgent',
    '--model', input.model,
    '--wait', '--json',
  ];
  return parseRun(await runCli(args, input.message));
}

// The tool lock only exists for Claude agents in the writer project, so a thread moved elsewhere must not receive documents.
async function assertThreadLocked(threadId: string): Promise<void> {
  const list = await runCli(['thread', 'list', '--project', config.writerWorkspace, '--json']);
  let threads: { threadId: string; providerInstanceId?: string }[] = [];
  try {
    threads = JSON.parse(list.stdout);
  } catch {
    throw new Error('T3 nevratil zoznam vlakien, skript sa neodoslal.');
  }
  const thread = threads.find((item) => item.threadId === threadId);
  if (thread?.providerInstanceId !== 'claudeAgent') {
    throw new Error('Vlakno skriptu uz nie je aktivny Claude agent v zamknutom projekte. Napis skript nanovo.');
  }
}

export async function continueThread(threadId: string, message: string): Promise<ThreadReply> {
  await assertThreadLocked(threadId);
  return parseRun(await runCli(['thread', 'send', threadId, '-', '--wait', '--json'], message));
}

// `thread start` needs the project registered in T3; adding it again only errors, which is harmless.
export async function ensureWriterProject(): Promise<void> {
  const list = await runCli(['thread', 'list', '--project', config.writerWorkspace, '--json']);
  if (list.code === 0) return;
  const added = await runCli(['project', 'add', config.writerWorkspace, '--title', 'podcast-generator-writer']);
  if (added.code !== 0) throw new Error(`T3 projekt sa nepodarilo pridat: ${added.stderr.trim().slice(0, 300)}`);
}

export async function t3Status(): Promise<{ ok: boolean; detail: string }> {
  try {
    await ensureWriterProject();
    return { ok: true, detail: 'Pripojene' };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}
