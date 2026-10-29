import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

/** tokyonight "night" palette, the LazyVim default colorscheme. */
export const c = {
  bg: '#1a1b26',
  bgDark: '#16161e',
  bgHighlight: '#292e42',
  bgVisual: '#283457',
  fg: '#c0caf5',
  fgDark: '#a9b1d6',
  fgGutter: '#3b4261',
  comment: '#565f89',
  blue: '#7aa2f7',
  cyan: '#7dcfff',
  magenta: '#bb9af7',
  purple: '#9d7cd8',
  orange: '#ff9e64',
  yellow: '#e0af68',
  green: '#9ece6a',
  teal: '#1abc9c',
  red: '#f7768e',
};

const editorTheme = EditorView.theme(
  {
    '&': { color: c.fg, backgroundColor: c.bg, height: '100%' },
    '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.5' },
    '.cm-content': { caretColor: c.fg, padding: '4px 0' },
    '.cm-gutters': { backgroundColor: c.bg, color: c.fgGutter, border: 'none' },
    '.cm-activeLineGutter': { backgroundColor: c.bgHighlight, color: c.orange },
    '.cm-activeLine': { backgroundColor: c.bgHighlight },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 12px 0 8px', minWidth: '4ch' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: `${c.bgVisual} !important`,
    },
    // Insert-mode bar cursor; CodeMirror's dark default (1.2px #444) is nearly invisible on bg.
    '.cm-cursor, .cm-dropCursor': { borderLeft: `2px solid ${c.fg}`, marginLeft: '-1px' },
    '.cm-fat-cursor': { background: `${c.fg} !important`, color: `${c.bg} !important` },
    '&:not(.cm-focused) .cm-fat-cursor': { background: 'none !important', outline: `1px solid ${c.fg}` },
    '.cm-searchMatch': { backgroundColor: '#3d59a1', outline: 'none' },
    '.cm-searchMatch-selected': { backgroundColor: c.orange, color: c.bg },
    '.cm-panels': { backgroundColor: c.bgDark, color: c.fg, borderTop: 'none' },
    '.cm-panels-bottom': { borderTop: 'none' },
    '.cm-vim-panel': { padding: '2px 8px', fontFamily: 'var(--mono)' },
    '.cm-vim-panel input': { color: c.fg, fontFamily: 'var(--mono)' },
    '.cm-tag': { color: c.teal },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: t.heading1, color: c.blue, fontWeight: 'bold' },
  { tag: t.heading2, color: c.yellow, fontWeight: 'bold' },
  { tag: t.heading3, color: c.green, fontWeight: 'bold' },
  { tag: [t.heading4, t.heading5, t.heading6], color: c.cyan, fontWeight: 'bold' },
  { tag: t.strong, color: c.orange, fontWeight: 'bold' },
  { tag: t.emphasis, color: c.magenta, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: c.comment },
  { tag: [t.link, t.url], color: c.cyan, textDecoration: 'underline' },
  { tag: t.monospace, color: c.green },
  { tag: t.quote, color: c.comment, fontStyle: 'italic' },
  { tag: [t.processingInstruction, t.meta], color: c.comment },
  { tag: t.list, color: c.orange },
  { tag: t.contentSeparator, color: c.comment },
  { tag: t.keyword, color: c.purple },
  { tag: t.string, color: c.green },
  { tag: t.comment, color: c.comment, fontStyle: 'italic' },
]);

export const tokyonight = [editorTheme, syntaxHighlighting(highlight)];
