import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  GutterMarker,
  MatchDecorator,
  ViewPlugin,
  drawSelection,
  gutter,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { Vim, getCM, vim } from '@replit/codemirror-vim';
import { tokyonight } from './theme';

class LineNumber extends GutterMarker {
  constructor(readonly text: string) {
    super();
  }
  eq(other: LineNumber) {
    return other.text === this.text;
  }
  toDOM() {
    return document.createTextNode(this.text);
  }
}

/** LazyVim's `number` + `relativenumber`: absolute on the cursor line, relative elsewhere. */
const relativeLineNumbers = gutter({
  class: 'cm-lineNumbers',
  lineMarker(view, line) {
    const cursor = view.state.doc.lineAt(view.state.selection.main.head).number;
    const n = view.state.doc.lineAt(line.from).number;
    return new LineNumber(String(n === cursor ? n : Math.abs(n - cursor)));
  },
  lineMarkerChange: (u: ViewUpdate) => u.selectionSet || u.docChanged,
  initialSpacer: (view) => new LineNumber(String(view.state.doc.lines)),
});

/** Highlight nb-style `#tags` (but not markdown headings). */
const tagMatcher = new MatchDecorator({
  regexp: /(?<=^|\s)#[\p{L}\p{N}_\-/]+/gu,
  decoration: Decoration.mark({ class: 'cm-tag' }),
});
const tagHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = tagMatcher.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = tagMatcher.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

/** Matches `jj` typed while a Japanese IME is on: ｊｊ, っｊ, ッｊ (or their ASCII forms). */
const JJ_IN_IME = /(?:[jｊ][jｊ]|[っッ][jｊ])$/;

/**
 * Leave insert mode while a Japanese IME is active. With the IME on, keydown
 * reports `key: "Process"`, which codemirror-vim ignores, so neither Esc nor
 * the `jj` mapping would reach Vim.
 */
function imeEscape(): Extension {
  let escAfterComposition = false;
  let jjSuffix: string | null = null;
  const inInsert = (view: EditorView) => !!getCM(view)?.state.vim?.insertMode;
  const toNormal = (view: EditorView) => {
    const cm = getCM(view);
    if (cm?.state.vim?.insertMode) Vim.handleKey(cm, '<Esc>', 'user');
  };

  return EditorView.domEventHandlers({
    keydown(e, view) {
      if (!inInsert(view) || e.code !== 'Escape') return false;
      if (e.isComposing || view.composing) {
        // The IME consumes this Esc to cancel the composition; follow up once it has.
        escAfterComposition = true;
      } else if (e.key === 'Process' || e.keyCode === 229) {
        // IME on but nothing being composed: Vim ignores "Process", so leave insert mode here.
        e.preventDefault();
        toNormal(view);
        return true;
      }
      return false;
    },
    compositionupdate(e, view) {
      const m = inInsert(view) ? JJ_IN_IME.exec(e.data) : null;
      if (m) {
        jjSuffix = m[0];
        // Blurring commits the composition, which fires compositionend.
        view.contentDOM.blur();
        setTimeout(() => view.focus(), 0);
      }
      return false;
    },
    compositionend(_e, view) {
      if (!escAfterComposition && jjSuffix === null) return false;
      const suffix = jjSuffix;
      escAfterComposition = false;
      jjSuffix = null;
      // Let CodeMirror apply the committed text first.
      setTimeout(() => {
        if (suffix) {
          const head = view.state.selection.main.head;
          if (view.state.sliceDoc(head - suffix.length, head) === suffix) {
            view.dispatch({ changes: { from: head - suffix.length, to: head } });
          }
        }
        toNormal(view);
      }, 0);
      return false;
    },
  });
}

export function editorExtensions(onUpdate: (u: ViewUpdate) => void): Extension[] {
  return [
    vim({ status: false }),
    imeEscape(),
    relativeLineNumbers,
    highlightActiveLine(),
    highlightActiveLineGutter(),
    drawSelection(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    markdown(),
    tagHighlight,
    EditorView.lineWrapping,
    tokyonight,
    EditorView.updateListener.of(onUpdate),
  ];
}

export function createState(doc: string, extensions: Extension[]): EditorState {
  return EditorState.create({ doc, extensions });
}
