import { describe, expect, it } from 'vitest';
import { searchMemos } from './search';

const file = (path: string, text: string | null) => ({ path, sha: path, text });
const files = [
  file('20261025235729.md', '# 買い物リスト\n\n- [ ] 牛乳\n- [ ] パン\n#todo\n'),
  file('20261026000310.md', 'Vim の練習\n`ciw` で単語を書き換える\n#vim #todo\n'),
  file('example.md', 'Hello World\n'),
  file('image.png', null),
];

describe('searchMemos', () => {
  it('finds Japanese text and reports the matching line and offset', () => {
    const [hit, ...rest] = searchMemos(files, '牛乳');
    expect(rest).toEqual([]);
    expect(hit.file.path).toBe('20261025235729.md');
    expect(hit.line).toBe('- [ ] 牛乳');
    expect(files[0].text!.slice(hit.offset, hit.offset + 2)).toBe('牛乳');
  });

  it('is case-insensitive', () => {
    expect(searchMemos(files, 'hello').map((h) => h.file.path)).toEqual(['example.md']);
    expect(searchMemos(files, 'VIM').map((h) => h.file.path)).toEqual(['20261026000310.md']);
  });

  it('requires every space-separated term (AND)', () => {
    expect(searchMemos(files, '#todo').length).toBe(2);
    expect(searchMemos(files, '#todo 牛乳').map((h) => h.file.path)).toEqual(['20261025235729.md']);
    expect(searchMemos(files, '#todo 存在しない')).toEqual([]);
  });

  it('matches file names too, with offset -1 when the body does not match', () => {
    const [hit] = searchMemos(files, 'example');
    expect(hit.file.path).toBe('example.md');
    expect(hit.offset).toBe(-1);
    expect(hit.line).toBe('');
  });

  it('matches dates in timestamp names but not the .md extension', () => {
    expect(searchMemos(files, '20261025').map((h) => h.file.path)).toEqual(['20261025235729.md']);
    expect(searchMemos(files, 'md')).toEqual([]);
  });

  it('returns nothing for an empty query', () => {
    expect(searchMemos(files, '   ')).toEqual([]);
  });
});
