import { extname } from 'node:path';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import type { SourceDoc } from '../shared/types.ts';

const KINDS: Record<string, SourceDoc['kind']> = {
  '.pdf': 'pdf',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
  '.docx': 'docx',
};

export class UnsupportedFileError extends Error {}

export function sourceKind(fileName: string): SourceDoc['kind'] {
  const kind = KINDS[extname(fileName).toLowerCase()];
  if (!kind) throw new UnsupportedFileError(`Subor ${fileName} nepodporujem. Pouzi PDF, MD, TXT alebo DOCX.`);
  return kind;
}

export async function extractSourceText(fileName: string, bytes: Uint8Array): Promise<string> {
  const kind = sourceKind(fileName);
  const text = normalize(await read(kind, bytes));
  if (!text) {
    throw new UnsupportedFileError(
      kind === 'pdf'
        ? `${fileName} nema textovu vrstvu, zrejme je to sken. OCR zatial nepodporujem.`
        : `${fileName} neobsahuje ziadny text.`,
    );
  }
  return text;
}

async function read(kind: SourceDoc['kind'], bytes: Uint8Array): Promise<string> {
  if (kind === 'pdf') {
    // pdf.js takes ownership of the buffer, so hand it a copy.
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  }
  if (kind === 'docx') {
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return value;
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function normalize(text: string): string {
  return text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
