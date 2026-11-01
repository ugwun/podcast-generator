import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';

const run = promisify(execFile);
const ffmpeg = ffmpegPath as unknown as string;

// ffmpeg writes its stats to stderr; a full decode to null proves the whole file is readable.
async function decode(path: string, filters: string[] = []): Promise<string> {
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-v', 'info', '-xerror', '-i', path, ...filters, '-f', 'null', '-'], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stderr;
}

export async function measureDuration(path: string): Promise<number> {
  const log = await decode(path);
  const times = [...log.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)];
  const last = times.at(-1);
  if (!last) throw new Error('ffmpeg nezistil dlzku audia.');
  return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
}

export async function measureLoudness(path: string): Promise<{ integratedLufs: number | null; truePeakDb: number | null }> {
  const log = await decode(path, ['-af', 'loudnorm=print_format=json']);
  const json = log.slice(log.lastIndexOf('{'), log.lastIndexOf('}') + 1);
  try {
    const stats = JSON.parse(json) as { input_i: string; input_tp: string };
    return { integratedLufs: Number(stats.input_i), truePeakDb: Number(stats.input_tp) };
  } catch {
    return { integratedLufs: null, truePeakDb: null };
  }
}

export async function joinSegments(paths: string[], output: string, tempo: number): Promise<void> {
  const list = `${output}.txt`;
  const entries = paths.map((path) => `file '${path.replace(/'/g, `'\\''`)}'`).join('\n');
  await writeFile(list, entries);
  const filters = [...(tempo > 1 ? [`atempo=${tempo.toFixed(4)}`] : []), 'loudnorm=I=-16:TP=-1.5:LRA=11'];
  await run(
    ffmpeg,
    ['-y', '-hide_banner', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-af', filters.join(','), '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', output],
    { maxBuffer: 16 * 1024 * 1024 },
  );
}
