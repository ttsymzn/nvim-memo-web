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
import { vim } from '@replit/codemirror-vim';
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

export function editorExtensions(onUpdate: (u: ViewUpdate) => void): Extension[] {
  return [
    vim({ status: false }),
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
