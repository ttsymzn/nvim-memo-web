import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState, Prec, type Extension } from '@codemirror/state';
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
import { pasteFromClipboard } from './clipboard';
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

/**
 * Leave insert mode while a Japanese IME is active. With the IME on, keydown
 * reports `key: "Process"`, which codemirror-vim ignores, so Esc would not
 * reach Vim.
 */
function imeEscape(): Extension {
  let escAfterComposition = false;
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
    compositionend(_e, view) {
      if (!escAfterComposition) return false;
      escAfterComposition = false;
      // Let CodeMirror apply the committed text first.
      setTimeout(() => toNormal(view), 0);
      return false;
    },
  });
}

/**
 * Normal/visual-mode keys typed with a Japanese IME on. codemirror-vim only
 * turns single-character IME text into keys; when the IME keeps composing,
 * the second key arrives as "ｇｇ" (or "gg") and was inserted into the memo.
 * Feed only the characters not yet sent to Vim, one by one, and never insert.
 */
function imeNormalMode(): Extension {
  // Text of the current composition that has already been sent to Vim.
  let fed = '';
  return [
    Prec.highest(
      EditorView.inputHandler.of((view, _from, _to, text) => {
        const cm = getCM(view);
        const vim = cm?.state.vim;
        if (!cm || !vim || vim.insertMode || cm.curOp?.isVimOp) return false;
        // f/t/r waiting for a literal character (e.g. fあ): codemirror-vim handles that.
        if (vim.expectLiteralNext) return false;
        const fresh = text.startsWith(fed) ? text.slice(fed.length) : text;
        fed = text;
        for (const ch of fresh) {
          // Through the plugin, so 'langmap' turns ｇ into g.
          cm.state.vimPlugin.handleKey({ key: ch, preventDefault() {}, stopPropagation() {} });
        }
        return true;
      }),
    ),
    EditorView.domEventHandlers({
      keydown(e) {
        if (e.key !== 'Process') fed = '';
        return false;
      },
      compositionstart() {
        fed = '';
        return false;
      },
      compositionend() {
        // The final commit re-sends the whole text; clear only after it.
        setTimeout(() => (fed = ''), 0);
        return false;
      },
    }),
  ];
}

export function editorExtensions(onUpdate: (u: ViewUpdate) => void): Extension[] {
  return [
    vim({ status: false }),
    imeEscape(),
    imeNormalMode(),
    pasteFromClipboard(),
    relativeLineNumbers,
    highlightActiveLine(),
    highlightActiveLineGutter(),
    drawSelection(),
    history(),
    // Lowest, so Vim always gets keys first; these only act in insert mode
    // (e.g. Enter inserting a newline) once Vim lets a key through.
    Prec.lowest(keymap.of([...defaultKeymap, ...historyKeymap])),
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
