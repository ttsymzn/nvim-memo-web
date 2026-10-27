import type { MemoFile } from './repo';

export interface SearchHit {
  file: MemoFile;
  /** Offset of the first match of the first term in the text, or -1 if only the file name matched. */
  offset: number;
  /** The line containing that match (trimmed), for list views. */
  line: string;
}

/**
 * Case-insensitive full-text search over memo names and contents.
 * Space-separated terms must all appear somewhere in the memo (AND).
 */
export function searchMemos(files: MemoFile[], query: string): SearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const hits: SearchHit[] = [];
  for (const file of files) {
    const text = file.text ?? '';
    const body = text.toLowerCase();
    // Without the extension, or every memo would match "m", "d" or "md".
    const name = file.path.replace(/\.md$/i, '').toLowerCase();
    if (!terms.every((t) => body.includes(t) || name.includes(t))) continue;

    const offset = body.indexOf(terms[0]);
    let line = '';
    if (offset >= 0) {
      const start = text.lastIndexOf('\n', offset - 1) + 1;
      const end = text.indexOf('\n', offset);
      line = text.slice(start, end === -1 ? undefined : end).trim();
    }
    hits.push({ file, offset, line });
  }
  return hits;
}
