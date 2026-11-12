import { Marked, type Token, type TokenizerAndRendererExtension, type Tokens } from 'marked';

/** One top-level markdown block and the 1-based source line it starts on. */
export interface PreviewBlock {
  line: number;
  html: string;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** nb-style `#tags`, highlighted like in the editor (`#todo`, not `# heading`). */
const TAG = /^#[\p{L}\p{N}_\-/]+/u;
const tagExtension: TokenizerAndRendererExtension = {
  name: 'tag',
  level: 'inline',
  start(src) {
    const m = /(^|\s)#[\p{L}\p{N}_\-/]/u.exec(src);
    return m ? m.index + m[1].length : undefined;
  },
  tokenizer(src) {
    const m = TAG.exec(src);
    if (m) return { type: 'tag', raw: m[0], text: m[0] };
  },
  renderer(token) {
    return `<span class="md-tag">${escapeHtml((token as Tokens.Generic).text as string)}</span>`;
  },
};

// A memo is notes, not prose: a single newline is a line break (like `breaks` on GitHub comments).
const md = new Marked({ gfm: true, breaks: true, extensions: [tagExtension] });

/**
 * Markdown -> HTML, split into top-level blocks that remember their source
 * line, so the preview can follow the editor's cursor. The HTML is not
 * sanitized here.
 */
export function markdownBlocks(text: string): PreviewBlock[] {
  const tokens = md.lexer(text);
  const blocks: PreviewBlock[] = [];
  let line = 1;
  for (const token of tokens as Token[]) {
    if (token.type !== 'space' && token.type !== 'def') {
      blocks.push({ line, html: md.parser([token]) });
    }
    line += (token.raw.match(/\n/g) ?? []).length;
  }
  return blocks;
}
