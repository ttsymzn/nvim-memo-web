import { describe, expect, it } from 'vitest';
import { markdownBlocks } from './preview';

describe('markdownBlocks', () => {
  it('renders each top-level block with the line it starts on', () => {
    const blocks = markdownBlocks('# 買い物リスト\n\n- [ ] 牛乳\n- [x] パン\n\n```js\nlet a\n```\n\n本文\n');
    expect(blocks.map((b) => b.line)).toEqual([1, 3, 6, 10]);
    expect(blocks[0].html).toContain('<h1');
    expect(blocks[1].html).toContain('type="checkbox"');
    expect(blocks[2].html).toContain('<code class="language-js">');
    expect(blocks[3].html).toContain('本文');
  });

  it('keeps line numbers after leading blank lines', () => {
    expect(markdownBlocks('\n\n# title\n').map((b) => b.line)).toEqual([3]);
  });

  it('treats a single newline as a line break', () => {
    expect(markdownBlocks('一行目\n二行目')[0].html).toContain('一行目<br>二行目');
  });

  it('highlights #tags but not headings, code or URL fragments', () => {
    const html = markdownBlocks('# 見出し\n\nメモ #todo #家\n\n`#code` https://example.com/#frag\n')
      .map((b) => b.html)
      .join('');
    expect(html).toContain('<span class="md-tag">#todo</span>');
    expect(html).toContain('<span class="md-tag">#家</span>');
    expect(html).toContain('<h1>見出し</h1>');
    expect(html).not.toContain('>#code</span>');
    expect(html).not.toContain('>#frag</span>');
  });

  it('resolves reference links defined later', () => {
    const blocks = markdownBlocks('see [nb][1]\n\n[1]: https://xwmx.github.io/nb/\n');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].html).toContain('href="https://xwmx.github.io/nb/"');
  });
});
