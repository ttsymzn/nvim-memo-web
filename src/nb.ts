// Helpers that mirror how `nb` lays out a notebook repository.

export const INDEX_FILE = '.index';

/** nb-style timestamp file name in local time, e.g. 20261027153000.md */
export function newMemoName(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.md`
  );
}

/** Append a file name to `.index` (one name per line, insertion order). */
export function appendToIndex(index: string, name: string): string {
  const lines = index.split('\n').filter((l) => l !== '');
  if (lines.includes(name)) return index;
  lines.push(name);
  return lines.join('\n') + '\n';
}

/** True for files that are notes (hidden nb files such as `.index` are not). */
export function isMemoPath(path: string): boolean {
  return !path.startsWith('.') && !path.includes('/');
}

/** A short title for list views: first heading, else first non-empty line. */
export function memoTitle(text: string): string {
  const lines = text.split('\n').map((l) => l.trim());
  const heading = lines.find((l) => /^#{1,6}\s/.test(l));
  if (heading) return heading.replace(/^#{1,6}\s+/, '');
  return lines.find((l) => l !== '') ?? '';
}

/**
 * Like Vim, the final newline of a file is not an editable line: drop it when
 * loading into the editor, so `G` lands on the last real line...
 */
export function toEditorText(fileText: string): string {
  return fileText.endsWith('\n') ? fileText.slice(0, -1) : fileText;
}

/** ...and write it back on save (Vim's 'fixeol'). An empty buffer stays empty. */
export function toFileText(editorText: string): string {
  return editorText === '' ? '' : `${editorText}\n`;
}

/** Ex command arguments may name a file without the .md extension. */
export function normalizeMemoName(arg: string): string {
  const name = arg.trim();
  return /\.[A-Za-z0-9]+$/.test(name) ? name : `${name}.md`;
}
