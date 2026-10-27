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

/** Ex command arguments may name a file without the .md extension. */
export function normalizeMemoName(arg: string): string {
  const name = arg.trim();
  return /\.[A-Za-z0-9]+$/.test(name) ? name : `${name}.md`;
}
