import { EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import { Vim, getCM } from '@replit/codemirror-vim';
import DOMPurify from 'dompurify';
import { clearKeyLog, keyLog, trapBackKey } from './backkey';
import { syncYanksToClipboard } from './clipboard';
import { isAuthError } from './github';
import { createState, editorExtensions } from './editor';
import { isMemoPath, memoTitle, newMemoName, normalizeMemoName, toEditorText, toFileText } from './nb';
import { markdownBlocks } from './preview';
import type { MemoRepo } from './repo';
import { searchMemos, type SearchHit } from './search';

interface Buffer {
  path: string;
  /** Saved editor state while the buffer is not shown. */
  state: EditorState;
  /** Text as last loaded from or written to the repository. */
  saved: string;
  /** Not in the repository yet (created with :new or :e). */
  isNew: boolean;
}

type SyncStatus = 'idle' | 'syncing' | 'saving' | 'error' | 'offline';
type Level = 'info' | 'error' | 'warn';
/** The two "windows": the editor and the markdown preview beside it. */
type Pane = 'editor' | 'preview';

const LEADER_TIMEOUT_MS = 1000;

/** LazyVim-style <leader> keys (leader = Space) -> [ex command, argument]. */
const LEADER_MAPS: Record<string, [string, string?]> = {
  fn: ['new'],
  bd: ['bd'],
  qq: ['qa'],
  // Until the fuzzy picker lands (M2), the file finders open the dashboard list.
  ' ': ['Dashboard'],
  ff: ['Dashboard'],
  // LazyVim's markdown extra: <leader>cp toggles the preview.
  cp: ['MarkdownPreviewToggle'],
  ww: ['wincmd', 'w'],
  wd: ['wincmd', 'c'],
};

/** Re-render the preview this long after the last edit. */
const PREVIEW_DEBOUNCE_MS = 120;
/** Preview scroll for j/k, in pixels. */
const PREVIEW_LINE_PX = 42;

const REFRESH_ON_FOCUS_MS = 30_000;
const REFRESH_INTERVAL_MS = 5 * 60_000;

const LOGO = [
  '███╗   ██╗██╗   ██╗██╗███╗   ███╗',
  '████╗  ██║██║   ██║██║████╗ ████║',
  '██╔██╗ ██║██║   ██║██║██╔████╔██║',
  '██║╚██╗██║╚██╗ ██╔╝██║██║╚██╔╝██║',
  '██║ ╚████║ ╚████╔╝ ██║██║ ╚═╝ ██║',
  '╚═╝  ╚═══╝  ╚═══╝  ╚═╝╚═╝     ╚═╝',
].join('\n');

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Append `text` to `parent`, wrapping each case-insensitive match of a query term in <mark>. */
function appendHighlighted(parent: HTMLElement, text: string, query: string) {
  const terms = query.split(/\s+/).filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${terms.join('|')})`, 'gi');
  text.split(re).forEach((part, i) => parent.append(i % 2 ? el('mark', '', part) : part));
}

/** 20261027072916.md -> 2026-10-27 07:29 */
function formatStamp(path: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})\d{2}\.md$/.exec(path);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : '';
}

let app: App | undefined;

export class App {
  private view: EditorView;
  private extensions: Extension[];
  private buffers = new Map<string, Buffer>();
  private current: string | null = null;
  private mode = 'normal';
  private sync: SyncStatus = 'idle';
  private lastRefresh = 0;
  private dashboardOpen = true;
  private dashboardIndex = 0;
  /** Text typed into the dashboard's `/` search; '' shows every memo. */
  private dashboardQuery = '';
  private saveQueue: Promise<unknown> = Promise.resolve();
  /** Keys typed after <leader>, or null when no leader sequence is pending. */
  private leader: string | null = null;
  private leaderTimer?: ReturnType<typeof setTimeout>;
  /** Time of a first `d` on the dashboard, waiting for the second (`dd` deletes). */
  private pendingD = 0;
  /** Time of a first `g` in the preview, waiting for the second (`gg` = top). */
  private pendingG = 0;
  /** <C-w> was pressed and the window command key is pending. */
  private windowPending = false;
  private windowTimer?: ReturnType<typeof setTimeout>;
  /** :MarkdownPreview is on (shown whenever a memo is, not over the dashboard). */
  private previewOpen = false;
  /** The window that last had focus. */
  private pane: Pane = 'editor';
  private previewTimer?: ReturnType<typeof setTimeout>;
  /** What the preview currently shows, to skip re-rendering the same text. */
  private previewShown = { path: '', text: '' };

  private dom = {
    bufferline: document.getElementById('bufferline')!,
    dashboard: document.getElementById('dashboard')!,
    editor: document.getElementById('editor')!,
    preview: document.getElementById('preview')!,
    statusline: document.getElementById('statusline')!,
    cmdline: document.getElementById('cmdline')!,
  };

  /** Set when GitHub rejected the token; syncing pauses until reauthenticated(). */
  private authLost = false;

  constructor(
    private repo: MemoRepo,
    private onLogout: () => void,
    /** Called once when GitHub answers 401: the host shows the login form. */
    private onAuthError: () => void,
  ) {
    app = this;
    this.extensions = [
      // Not keymap.of: all keymaps share one handler, so a high-precedence
      // keymap would run the default Enter binding before Vim sees the key.
      Prec.highest(
        EditorView.domEventHandlers({
          keydown: (e, view) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
              e.preventDefault();
              void this.write();
              return true;
            }
            const vim = getCM(view)?.state.vim;
            if (this.onWindowKey(e, !!vim && !vim.insertMode)) return true;
            return this.onLeaderKey(e, view);
          },
        }),
      ),
      ...editorExtensions((u) => this.onEditorUpdate(u)),
    ];
    this.view = new EditorView({ parent: this.dom.editor, state: createState('', this.extensions) });
    this.attachVim();

    repo.onChange((changed) => this.onRemoteChange(changed));
    document.addEventListener('keydown', (e) => this.onDashboardKey(e));
    this.dom.preview.addEventListener('keydown', (e) => this.onPreviewKey(e));
    this.dom.preview.addEventListener('click', (e) => this.onPreviewClick(e));
    this.dom.editor.addEventListener('focusin', () => this.setPane('editor'));
    this.dom.preview.addEventListener('focusin', () => this.setPane('preview'));
    trapBackKey();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - this.lastRefresh > REFRESH_ON_FOCUS_MS) {
        void this.refresh();
      }
    });
    window.addEventListener('online', () => void this.refresh());
    window.addEventListener('offline', () => this.setSync('offline'));
    setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);

    this.render();
  }

  async start() {
    if (await this.repo.loadCache()) this.render();
    await this.refresh();
  }

  // ---------------------------------------------------------------- sync

  private setSync(s: SyncStatus) {
    this.sync = s;
    this.renderStatusline();
  }

  async refresh() {
    if (this.authLost) return;
    if (!navigator.onLine) return this.setSync('offline');
    this.setSync('syncing');
    try {
      await this.repo.refresh();
      this.lastRefresh = Date.now();
      this.setSync('idle');
    } catch (e) {
      this.setSync('error');
      if (!this.handleAuthError(e)) this.message(`同期に失敗しました: ${(e as Error).message}`, 'error');
    }
    this.render();
  }

  /** On 401, stop syncing and hand over to the login form. Returns true if `e` was a 401. */
  private handleAuthError(e: unknown): boolean {
    if (!isAuthError(e)) return false;
    this.message('token が無効になりました（401 Bad credentials）。新しい token で接続し直してください', 'error');
    if (!this.authLost) {
      this.authLost = true;
      this.onAuthError();
    }
    return true;
  }

  /** The host swapped in a working token: resume syncing, keeping open buffers and unsaved edits. */
  reauthenticated() {
    this.authLost = false;
    const unsaved = [...this.buffers.values()].filter((b) => this.isModified(b) || b.isNew).length;
    this.message(
      unsaved
        ? `再接続しました。未保存のメモが ${unsaved} 件あります（:w または :wa で保存）`
        : '再接続しました',
    );
    void this.refresh();
    if (this.current && !this.dashboardOpen) this.view.focus();
  }

  private onRemoteChange(changed: string[]) {
    for (const path of changed) {
      const buf = this.buffers.get(path);
      if (!buf) continue;
      const remote = this.repo.get(path);
      if (!remote) {
        this.message(`"${path}" はリモートで削除されました`, 'warn');
        continue;
      }
      if (remote.text === null || toEditorText(remote.text) === buf.saved) continue;
      if (this.isModified(buf)) {
        this.message(`W12: "${path}" はリモートでも変更されています（:w で上書き、:e! で読み直し）`, 'warn');
        continue;
      }
      this.replaceText(buf, toEditorText(remote.text));
      buf.saved = toEditorText(remote.text);
      this.message(`"${path}" をリモートの内容で更新しました`);
    }
    this.render();
  }

  // ------------------------------------------------------------- buffers

  private text(buf: Buffer): string {
    return (buf.path === this.current ? this.view.state : buf.state).doc.toString();
  }

  private isModified(buf: Buffer) {
    return this.text(buf) !== buf.saved;
  }

  private replaceText(buf: Buffer, text: string) {
    if (buf.path === this.current) {
      const head = Math.min(this.view.state.selection.main.head, text.length);
      this.view.dispatch({
        changes: { from: 0, to: this.view.state.doc.length, insert: text },
        selection: { anchor: head },
      });
    } else {
      buf.state = createState(text, this.extensions);
    }
  }

  private attachVim() {
    const cm = getCM(this.view);
    cm?.on('vim-mode-change', (e: { mode: string; subMode?: string }) => {
      this.mode = e.subMode ? `${e.mode}-${e.subMode}` : e.mode;
      this.renderStatusline();
    });
    this.mode = 'normal';
  }

  private show(path: string) {
    if (this.current && this.buffers.has(this.current)) {
      this.buffers.get(this.current)!.state = this.view.state;
    }
    this.current = path;
    this.view.setState(this.buffers.get(path)!.state);
    this.attachVim();
    this.dashboardOpen = false;
    this.render();
    this.view.focus();
  }

  /** Open (or switch to) a memo; `at` puts the cursor at that offset, e.g. a search match. */
  open(path: string, at?: number) {
    if (!this.buffers.has(path)) {
      const file = this.repo.get(path);
      if (file && file.text === null) {
        this.message(`"${path}" はバイナリファイルのため開けません`, 'error');
        return;
      }
      const text = toEditorText(file?.text ?? '');
      this.buffers.set(path, { path, state: createState(text, this.extensions), saved: text, isNew: !file });
      if (!file) this.message(`"${path}" [New]`);
    }
    this.show(path);
    if (at !== undefined) {
      const anchor = Math.min(at, this.view.state.doc.length);
      this.view.dispatch({ selection: { anchor }, scrollIntoView: true });
    }
  }

  newMemo() {
    let name = newMemoName();
    // Two :new within the same second would collide; bump the seconds.
    for (let t = Date.now(); this.buffers.has(name) || this.repo.get(name); ) {
      t += 1000;
      name = newMemoName(new Date(t));
    }
    this.open(name);
    Vim.handleKey(getCM(this.view)!, 'i', 'mapping');
  }

  private close(path: string, force: boolean): boolean {
    const buf = this.buffers.get(path);
    if (!buf) return true;
    if (!force && this.isModified(buf)) {
      this.message('E37: 変更が保存されていません（! で破棄）', 'error');
      return false;
    }
    const order = [...this.buffers.keys()];
    const i = order.indexOf(path);
    this.buffers.delete(path);
    if (this.current === path) {
      this.current = null;
      const next = order[i + 1] ?? order[i - 1];
      if (next && next !== path) this.show(next);
      else this.showDashboard();
    }
    this.render();
    return true;
  }

  private cycle(step: number) {
    const order = [...this.buffers.keys()];
    if (!order.length) return;
    const i = this.current ? order.indexOf(this.current) : -1;
    this.show(order[(i + step + order.length) % order.length]);
  }

  showDashboard() {
    if (this.current && this.buffers.has(this.current)) {
      this.buffers.get(this.current)!.state = this.view.state;
    }
    this.dashboardOpen = true;
    this.render();
  }

  private hideDashboard() {
    if (!this.current) return;
    this.dashboardOpen = false;
    this.render();
    this.view.focus();
  }

  // --------------------------------------------------------------- write

  /** :w — commit the current (or given) buffer. Resolves true on success. */
  write(path = this.current): Promise<boolean> {
    if (!path) {
      this.message('E32: ファイル名がありません', 'error');
      return Promise.resolve(false);
    }
    const run = async () => {
      const buf = this.buffers.get(path);
      if (!buf) return false;
      if (!navigator.onLine) {
        this.message('オフラインのため保存できません（オフライン保存は M4 で対応予定）', 'error');
        return false;
      }
      const text = this.text(buf);
      const fileText = toFileText(text);
      this.setSync('saving');
      const started = performance.now();
      try {
        const result = await this.repo.save(path, fileText);
        const seconds = ((performance.now() - started) / 1000).toFixed(1);
        buf.saved = text;
        buf.isNew = false;
        this.setSync('idle');
        const lines = fileText === '' ? 0 : fileText.split('\n').length - 1;
        const size = new TextEncoder().encode(fileText).length;
        const tag = result === 'added' ? ' [New]' : result === 'unchanged' ? ' (変更なし)' : '';
        this.message(`"${path}"${tag} ${lines}L, ${size}B written (${seconds}s)`);
        this.render();
        return true;
      } catch (e) {
        this.setSync('error');
        if (!this.handleAuthError(e)) this.message(`保存に失敗しました: ${(e as Error).message}`, 'error');
        return false;
      }
    };
    const p = this.saveQueue.then(run);
    this.saveQueue = p.catch(() => undefined);
    return p;
  }

  async writeAll() {
    for (const buf of [...this.buffers.values()]) {
      if (this.isModified(buf) || buf.isNew) await this.write(buf.path);
    }
  }

  // -------------------------------------------------------------- delete

  /**
   * :Delete — delete a memo from the repository (`[nb] Delete:` commit, also
   * dropped from `.index`) and close its buffer. Asks first unless `force`.
   */
  async deleteMemo(path: string, force = false): Promise<boolean> {
    const buf = this.buffers.get(path);
    const inRepo = !!this.repo.get(path);
    if (!inRepo && !buf) {
      this.message(`E: "${path}" というメモはありません`, 'error');
      return false;
    }
    if (!force && !(await this.confirm(`"${path}" を削除しますか？ (y/N) `))) {
      this.message('削除を取り消しました');
      if (!this.dashboardOpen && this.current) this.view.focus();
      return false;
    }
    if (!inRepo) {
      // Never saved: only the buffer exists.
      this.close(path, true);
      this.message(`"${path}" は未保存だったのでバッファだけ閉じました`);
      return true;
    }
    if (!navigator.onLine) {
      this.message('オフラインのため削除できません', 'error');
      return false;
    }
    const run = async () => {
      this.setSync('saving');
      try {
        const removed = await this.repo.remove(path);
        this.setSync('idle');
        this.close(path, true);
        this.message(removed ? `"${path}" を削除しました` : `"${path}" はすでにリモートで削除されていました`);
        this.render();
        return true;
      } catch (e) {
        this.setSync('error');
        if (!this.handleAuthError(e)) this.message(`削除に失敗しました: ${(e as Error).message}`, 'error');
        return false;
      }
    };
    // Queue behind pending saves so a :w of the same memo cannot land after the delete.
    const p = this.saveQueue.then(run);
    this.saveQueue = p.catch(() => undefined);
    return p;
  }

  /** A one-key y/N question in the command line. Anything but y answers no. */
  private confirm(question: string): Promise<boolean> {
    return new Promise((resolve) => {
      const input = el('input', 'prompt');
      input.setAttribute('aria-label', question);
      this.dom.cmdline.replaceChildren(el('span', '', question), input);
      this.dom.cmdline.dataset.level = 'warn';
      let done = false;
      const finish = (yes: boolean) => {
        if (done) return;
        done = true;
        this.dom.cmdline.replaceChildren();
        resolve(yes);
      };
      const isYes = (ch: string) => /^[yYｙＹ]/.test(ch);
      input.addEventListener('keydown', (e) => {
        if (e.isComposing) return;
        if (e.key === 'Escape' || e.key === 'Enter') {
          e.preventDefault();
          return finish(false);
        }
        // Modifiers, and soft keyboards that report "Unidentified": wait for the input event.
        if (e.key.length !== 1) return;
        e.preventDefault();
        finish(isYes(e.key));
      });
      input.addEventListener('input', () => input.value && finish(isYes(input.value)));
      // After the current key event: closing Vim's own `:` prompt refocuses the editor.
      setTimeout(() => {
        if (done) return;
        input.focus();
        input.addEventListener('blur', () => finish(false));
      });
    });
  }

  // ----------------------------------------------------------------- ex

  /** Ex commands shared by the editor (via Vim.defineEx) and the dashboard prompt. */
  ex(name: string, bang: boolean, arg: string) {
    switch (name) {
      case 'w':
        if (arg) return this.message('E: :w <ファイル名> は未対応です', 'error');
        return void this.write();
      case 'wa':
        return void this.writeAll();
      case 'q':
        // :q in the preview window closes that window, as in Neovim.
        if (this.previewVisible() && this.pane === 'preview') return this.closePreview();
        if (!this.current) return;
        return void this.close(this.current, bang);
      case 'qa': {
        const dirty = [...this.buffers.values()].filter((b) => this.isModified(b));
        if (dirty.length && !bang) return this.message(`E37: 未保存のバッファが ${dirty.length} 個あります（:qa! で破棄）`, 'error');
        this.buffers.clear();
        this.current = null;
        return this.showDashboard();
      }
      case 'wq':
      case 'x':
        if (!this.current) return;
        {
          const path = this.current;
          const buf = this.buffers.get(path)!;
          if (name === 'x' && !this.isModified(buf) && !buf.isNew) return void this.close(path, true);
          return void this.write(path).then((ok) => ok && this.close(path, true));
        }
      case 'e':
        if (arg) return this.open(normalizeMemoName(arg));
        if (!this.current) return;
        {
          // :e reloads from the repository; :e! also drops local changes.
          const buf = this.buffers.get(this.current)!;
          if (this.isModified(buf) && !bang) return this.message('E37: 変更が保存されていません（:e! で破棄）', 'error');
          const remote = toEditorText(this.repo.get(buf.path)?.text ?? '');
          this.replaceText(buf, remote);
          buf.saved = remote;
          return this.render();
        }
      case 'new':
        return this.newMemo();
      case 'bn':
        return this.cycle(1);
      case 'bp':
        return this.cycle(-1);
      case 'bd':
        if (!this.current) return;
        return void this.close(this.current, bang);
      case 'ls':
        return this.message(
          [...this.buffers.values()]
            .map((b, i) => `${i + 1}${b.path === this.current ? ' %a' : '   '} ${this.isModified(b) ? '+' : ' '} "${b.path}"`)
            .join('\n') || 'バッファはありません',
        );
      case 'Delete': {
        // :Delete [name] — the named memo, else the dashboard selection, else the current buffer.
        const path = arg
          ? normalizeMemoName(arg)
          : this.dashboardOpen
            ? this.dashboardItems()[this.dashboardIndex]?.file.path
            : this.current;
        if (!path) return this.message('E32: ファイル名がありません', 'error');
        return void this.deleteMemo(path, bang);
      }
      case 'MarkdownPreview':
        return this.openPreview();
      case 'MarkdownPreviewStop':
        return this.closePreview();
      case 'MarkdownPreviewToggle':
        return this.previewOpen ? this.closePreview() : this.openPreview();
      case 'wincmd':
        if (!arg) return this.message('E471: 引数が必要です（例: :wincmd w）', 'error');
        return this.windowCommand(arg[0]);
      case 'close':
      case 'only':
        return this.closePreview();
      case 'Dashboard':
        return this.showDashboard();
      case 'Sync':
        return void this.refresh();
      case 'Logout':
        return this.onLogout();
      case 'KeyLog':
        // Esc / back events recorded across app restarts (:KeyLog! clears them).
        if (bang) {
          clearKeyLog();
          return this.message('キーログを消去しました');
        }
        return this.message(keyLog());
    }
    this.message(`E492: エディタのコマンドではありません: ${name}`, 'error');
  }

  // ------------------------------------------------------------ messages

  message(text: string, level: Level = 'info') {
    this.dom.cmdline.textContent = text;
    this.dom.cmdline.dataset.level = level;
  }

  // --------------------------------------------------------------- input

  /**
   * <leader> (Space) sequences. Handled here rather than with Vim.map: a
   * mapping like <Space>fn only ever partially matches, and codemirror-vim
   * prefers its built-in full match `<Space>` -> `l`.
   */
  private onLeaderKey(e: KeyboardEvent, view: EditorView): boolean {
    const vim = getCM(view)?.state.vim;
    if (!vim || vim.insertMode || e.isComposing) return false;
    // Space after f/t/r or an operator is a literal key for Vim.
    return this.leaderKey(e, !vim.inputState.keyBuffer.length && !vim.inputState.operator);
  }

  /** The <leader> state machine, shared by the editor and the preview. */
  private leaderKey(e: KeyboardEvent, canStart: boolean): boolean {
    if (this.leader === null) {
      const plain = e.key === ' ' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
      if (!plain || !canStart) return false;
      this.leader = '';
      this.message('<leader>');
    } else if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) {
      return true;
    } else if (e.key === 'Escape') {
      this.endLeader();
    } else {
      const seq = this.leader + e.key;
      const isPrefix = Object.keys(LEADER_MAPS).some((k) => k !== seq && k.startsWith(seq));
      if (LEADER_MAPS[seq] && !isPrefix) {
        this.endLeader();
        const [name, arg = ''] = LEADER_MAPS[seq];
        this.ex(name, false, arg);
      } else if (isPrefix) {
        this.leader = seq;
        this.message(`<leader>${seq}`);
      } else {
        this.endLeader();
        this.message(`<leader>${seq} は割り当てられていません`, 'warn');
      }
    }
    e.preventDefault();
    clearTimeout(this.leaderTimer);
    if (this.leader !== null) this.leaderTimer = setTimeout(() => this.endLeader(), LEADER_TIMEOUT_MS);
    return true;
  }

  private endLeader() {
    this.leader = null;
    clearTimeout(this.leaderTimer);
    if (this.dom.cmdline.textContent?.startsWith('<leader>')) this.message('');
  }

  private onEditorUpdate(u: ViewUpdate) {
    if (u.docChanged || u.selectionSet) {
      if (u.docChanged) this.renderBufferline();
      this.renderStatusline();
    }
    if (!this.previewVisible()) return;
    if (u.docChanged) {
      clearTimeout(this.previewTimer);
      this.previewTimer = setTimeout(() => this.renderPreview(), PREVIEW_DEBOUNCE_MS);
    } else if (u.selectionSet) {
      this.syncPreviewScroll();
    }
  }

  // ------------------------------------------------------------- windows

  /**
   * <C-w>{key}: Neovim's window commands, in the editor (Normal mode) and the
   * preview. Desktop browsers may keep Ctrl+W for "close tab"; then use
   * <leader>ww / <leader>wd or :wincmd.
   */
  private onWindowKey(e: KeyboardEvent, canStart: boolean): boolean {
    if (e.isComposing) return false;
    if (this.windowPending) {
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return true;
      e.preventDefault();
      this.windowPending = false;
      clearTimeout(this.windowTimer);
      this.message('');
      if (e.key !== 'Escape') this.windowCommand(e.key);
      return true;
    }
    if (!canStart || !e.ctrlKey || e.altKey || e.metaKey || e.key.toLowerCase() !== 'w') return false;
    e.preventDefault();
    this.windowPending = true;
    this.message('<C-w>');
    this.windowTimer = setTimeout(() => {
      this.windowPending = false;
      if (this.dom.cmdline.textContent === '<C-w>') this.message('');
    }, LEADER_TIMEOUT_MS);
    return true;
  }

  private windowCommand(key: string) {
    switch (key) {
      case 'w':
      case 'W':
      case 'p':
        return this.focusPane(this.pane === 'editor' ? 'preview' : 'editor');
      case 'h':
      case 'k':
        return this.focusPane('editor');
      case 'l':
      case 'j':
        return this.focusPane('preview');
      case 'q':
      case 'c':
      case 'o':
        // The preview is the only window that can close; the editor always stays.
        return this.closePreview();
      case 'v':
      case 's':
        return this.message('E: 画面分割（:vsplit / :split）は未対応です。プレビューは <leader>cp か :MarkdownPreview', 'warn');
    }
    this.message(`<C-w>${key} は未対応です`, 'warn');
  }

  private setPane(pane: Pane) {
    if (this.pane === pane) return;
    this.pane = pane;
    this.renderStatusline();
  }

  private focusPane(pane: Pane) {
    if (pane === 'preview') {
      if (this.previewVisible()) this.dom.preview.focus({ preventScroll: true });
    } else if (this.current && !this.dashboardOpen) {
      this.view.focus();
    }
  }

  private previewVisible() {
    return this.previewOpen && !this.dashboardOpen && !!this.current;
  }

  /** :MarkdownPreview — show the rendered memo beside the editor. Focus stays in the editor. */
  private openPreview() {
    this.previewOpen = true;
    this.render();
    this.syncPreviewScroll();
    if (!this.current) this.message('メモを開くとプレビューが表示されます');
  }

  private closePreview() {
    if (!this.previewOpen) return;
    const hadFocus = this.pane === 'preview';
    this.previewOpen = false;
    this.pane = 'editor';
    this.render();
    if (hadFocus) this.focusPane('editor');
  }

  private renderPreview() {
    clearTimeout(this.previewTimer);
    if (!this.previewVisible()) return;
    const path = this.current!;
    const text = this.view.state.doc.toString();
    if (this.previewShown.path === path && this.previewShown.text === text) return;
    const pathChanged = this.previewShown.path !== path;
    this.previewShown = { path, text };

    const body = el('article', 'md-body');
    for (const block of markdownBlocks(text)) {
      const div = el('div', 'md-block');
      div.dataset.line = String(block.line);
      div.innerHTML = DOMPurify.sanitize(block.html);
      body.append(div);
    }
    if (!body.childElementCount) body.append(el('p', 'md-empty', '（空のメモ）'));
    this.dom.preview.replaceChildren(body);
    if (pathChanged) this.dom.preview.scrollTop = 0;
    this.syncPreviewScroll();
  }

  /**
   * Scroll the preview to the block under the editor's cursor (a third of the
   * way down), interpolating inside long blocks. Not while the preview has
   * focus: then it is being scrolled by hand.
   */
  private syncPreviewScroll() {
    if (this.pane === 'preview') return;
    const preview = this.dom.preview;
    const state = this.view.state;
    const line = state.doc.lineAt(state.selection.main.head).number;
    const blocks = [...preview.querySelectorAll<HTMLElement>('.md-block')];
    let i = -1;
    while (i + 1 < blocks.length && Number(blocks[i + 1].dataset.line) <= line) i++;
    if (i < 0) {
      preview.scrollTop = 0;
      return;
    }
    const block = blocks[i];
    const start = Number(block.dataset.line);
    const end = i + 1 < blocks.length ? Number(blocks[i + 1].dataset.line) : state.doc.lines + 1;
    const fraction = Math.min(1, (line - start) / Math.max(1, end - start));
    const top = block.offsetTop + fraction * block.offsetHeight;
    preview.scrollTop = Math.max(0, top - preview.clientHeight / 3);
  }

  /** Keys in the preview window: scrolling, buffers, <leader>, <C-w>, `:`. */
  private onPreviewKey(e: KeyboardEvent) {
    if (e.isComposing || (e.target as HTMLElement).closest('input, textarea')) return;
    if (this.onWindowKey(e, true) || this.leaderKey(e, true)) return;
    const preview = this.dom.preview;
    const page = preview.clientHeight;
    const scroll = (dy: number) => preview.scrollBy({ top: dy });
    const ctrl: Record<string, () => void> = {
      d: () => scroll(page / 2),
      u: () => scroll(-page / 2),
      f: () => scroll(page * 0.9),
      b: () => scroll(-page * 0.9),
      e: () => scroll(PREVIEW_LINE_PX),
      y: () => scroll(-PREVIEW_LINE_PX),
    };
    const plain: Record<string, () => void> = {
      j: () => scroll(PREVIEW_LINE_PX),
      ArrowDown: () => scroll(PREVIEW_LINE_PX),
      k: () => scroll(-PREVIEW_LINE_PX),
      ArrowUp: () => scroll(-PREVIEW_LINE_PX),
      PageDown: () => scroll(page * 0.9),
      PageUp: () => scroll(-page * 0.9),
      G: () => (preview.scrollTop = preview.scrollHeight),
      H: () => this.cycle(-1),
      L: () => this.cycle(1),
      q: () => this.closePreview(),
      // Esc goes back to the editor (also Android's back key, see backkey.ts).
      Escape: () => this.focusPane('editor'),
      ':': () => this.prompt(),
    };
    if (e.altKey || e.metaKey) return;
    let fn = e.ctrlKey ? ctrl[e.key] : plain[e.key];
    if (!e.ctrlKey && e.key === 'g') {
      // gg: top. A lone g waits for the second.
      const second = Date.now() - this.pendingG < LEADER_TIMEOUT_MS;
      this.pendingG = second ? 0 : Date.now();
      fn = () => second && (preview.scrollTop = 0);
    } else {
      this.pendingG = 0;
    }
    if (fn) {
      e.preventDefault();
      fn();
    }
  }

  /** Links: web pages open in a new tab, relative links to memos open the memo. */
  private onPreviewClick(e: MouseEvent) {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href') ?? '';
    if (/^(https?:|mailto:)/i.test(href)) {
      window.open(a.href, '_blank', 'noopener');
      return;
    }
    if (!href || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return;
    let name = href.split('#')[0].replace(/^\.\//, '');
    try {
      name = decodeURIComponent(name);
    } catch {
      // Keep the raw href.
    }
    const path = normalizeMemoName(name);
    if (this.buffers.has(path) || this.repo.get(path)) this.open(path);
    else this.message(`E: "${path}" というメモはありません`, 'error');
  }

  /**
   * Dashboard rows: all memos (timestamped newest first, then other names
   * alphabetically), or the hits of the current `/` search.
   */
  private dashboardItems(): SearchHit[] {
    const stamped = (p: string) => formatStamp(p) !== '';
    const files = this.repo
      .files()
      .filter((f) => isMemoPath(f.path))
      .sort((a, b) => {
        if (stamped(a.path) !== stamped(b.path)) return stamped(a.path) ? -1 : 1;
        return stamped(a.path) ? b.path.localeCompare(a.path) : a.path.localeCompare(b.path);
      });
    if (this.dashboardQuery) return searchMemos(files, this.dashboardQuery);
    return files.map((file) => ({ file, offset: -1, line: '' }));
  }

  private openHit(hit: SearchHit | undefined) {
    if (!hit) return;
    this.dashboardQuery = '';
    this.open(hit.file.path, hit.offset >= 0 ? hit.offset : undefined);
  }

  private moveDashboard(i: number) {
    const count = this.dashboardItems().length;
    this.dashboardIndex = Math.max(0, Math.min(count - 1, i));
    this.renderDashboard();
  }

  private onDashboardKey(e: KeyboardEvent) {
    if (!this.dashboardOpen || e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.target as HTMLElement).closest('input, textarea')) return;
    // With the IME on, / arrives as "Process" (code Slash) or as ／ / ・.
    const key = e.key === 'Process' && e.code === 'Slash' ? '/' : e.key === '／' || e.key === '・' ? '/' : e.key;
    const keys: Record<string, () => void> = {
      j: () => this.moveDashboard(this.dashboardIndex + 1),
      ArrowDown: () => this.moveDashboard(this.dashboardIndex + 1),
      k: () => this.moveDashboard(this.dashboardIndex - 1),
      ArrowUp: () => this.moveDashboard(this.dashboardIndex - 1),
      g: () => this.moveDashboard(0),
      G: () => this.moveDashboard(Infinity),
      Enter: () => this.openHit(this.dashboardItems()[this.dashboardIndex]),
      l: () => this.openHit(this.dashboardItems()[this.dashboardIndex]),
      n: () => this.newMemo(),
      r: () => void this.refresh(),
      '/': () => this.searchPrompt(),
      // Esc first clears a search, then leaves the dashboard.
      Escape: () => (this.dashboardQuery ? this.setDashboardQuery('') : this.hideDashboard()),
      q: () => this.hideDashboard(),
      ':': () => this.prompt(),
    };
    if (key === 'd') {
      e.preventDefault();
      // dd: delete the selected memo (asks first). A lone d waits for the second.
      if (Date.now() - this.pendingD < LEADER_TIMEOUT_MS) {
        this.pendingD = 0;
        const hit = this.dashboardItems()[this.dashboardIndex];
        if (hit) void this.deleteMemo(hit.file.path);
      } else {
        this.pendingD = Date.now();
        this.message('d');
      }
      return;
    }
    this.pendingD = 0;
    const fn = keys[key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  }

  private setDashboardQuery(query: string) {
    this.dashboardQuery = query;
    this.dashboardIndex = 0;
    this.renderDashboard();
  }

  /** `/` on the dashboard: search all memos as you type (Telescope-style). */
  private searchPrompt() {
    const input = el('input', 'prompt');
    input.setAttribute('aria-label', 'メモを検索');
    input.value = this.dashboardQuery;
    this.dom.cmdline.replaceChildren(el('span', '', '/'), input);
    this.dom.cmdline.dataset.level = 'info';
    input.focus();
    input.addEventListener('input', () => {
      // The IME may have typed the / that opened this prompt as ／ or ・.
      if (/^[／・]/.test(input.value)) input.value = input.value.slice(1);
      this.setDashboardQuery(input.value.trim());
    });
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return; // Enter / arrows while the IME is converting
      const down = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n');
      const up = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p');
      if (down || up) {
        e.preventDefault();
        this.moveDashboard(this.dashboardIndex + (down ? 1 : -1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.dom.cmdline.replaceChildren();
        this.openHit(this.dashboardItems()[this.dashboardIndex]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.dom.cmdline.replaceChildren();
        this.setDashboardQuery('');
      }
    });
    input.addEventListener('blur', () => input.isConnected && this.dom.cmdline.replaceChildren());
  }

  /** A minimal `:` prompt for the dashboard and the preview, where no editor has focus. */
  private prompt() {
    const input = el('input', 'prompt');
    input.setAttribute('aria-label', 'Ex コマンド');
    this.dom.cmdline.replaceChildren(el('span', '', ':'), input);
    this.dom.cmdline.dataset.level = 'info';
    const fromPreview = this.previewVisible() && this.pane === 'preview';
    // Back to the preview, unless the command moved focus somewhere (e.g. :e opens the editor).
    const refocus = () => {
      const active = document.activeElement;
      if (fromPreview && this.previewVisible() && (!active || active === document.body)) this.focusPane('preview');
    };
    input.focus();
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.dom.cmdline.replaceChildren();
        return refocus();
      }
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      const line = input.value.trim();
      this.dom.cmdline.replaceChildren();
      const m = /^(\w+)(!?)\s*(.*)$/.exec(line);
      if (m) this.ex(EX_ALIASES[m[1]] ?? m[1], m[2] === '!', m[3]);
      refocus();
    });
    input.addEventListener('blur', () => input.isConnected && this.dom.cmdline.replaceChildren());
  }

  // -------------------------------------------------------------- render

  private render() {
    this.dom.dashboard.hidden = !this.dashboardOpen;
    this.dom.editor.hidden = this.dashboardOpen;
    this.dom.preview.hidden = !this.previewVisible();
    this.renderBufferline();
    this.renderStatusline();
    if (this.dashboardOpen) this.renderDashboard();
    this.renderPreview();
  }

  private renderBufferline() {
    const tabs = [...this.buffers.values()].map((b) => {
      const tab = el('button', 'buf' + (b.path === this.current && !this.dashboardOpen ? ' active' : ''));
      tab.append(el('span', 'name', b.path), el('span', 'mod', this.isModified(b) ? '●' : ''));
      tab.addEventListener('click', () => this.show(b.path));
      return tab;
    });
    this.dom.bufferline.replaceChildren(...tabs);
  }

  private renderStatusline() {
    const mode = this.dashboardOpen ? 'dashboard' : this.previewVisible() && this.pane === 'preview' ? 'preview' : this.mode;
    const modeLabel = mode.replace('visual-linewise', 'v-line').replace('visual-blockwise', 'v-block').toUpperCase();
    const modeKey = mode.split('-')[0];
    const buf = this.current && !this.dashboardOpen ? this.buffers.get(this.current) : undefined;

    const left = el('div', 'sl-left');
    left.append(el('span', `sl-mode m-${modeKey}`, ` ${modeLabel} `), el('span', 'sl-branch', ` ${this.repo.transport.label}`));
    if (buf) left.append(el('span', 'sl-file', `${buf.path}${this.isModified(buf) ? ' [+]' : ''}${buf.isNew ? ' [New]' : ''}`));

    const syncText: Record<SyncStatus, string> = {
      idle: this.repo.head ? `✓ ${this.repo.head.commit.slice(0, 7)}` : '',
      syncing: '⟳ 同期中',
      saving: '⟳ 保存中',
      error: '✗ エラー',
      offline: '⚠ オフライン',
    };
    const right = el('div', 'sl-right');
    right.append(el('span', `sl-sync s-${this.sync}`, syncText[this.sync]));
    if (buf) {
      const s = this.view.state;
      const line = s.doc.lineAt(s.selection.main.head);
      const pct = s.doc.lines <= 1 ? 'Top' : `${Math.round((line.number / s.doc.lines) * 100)}%`;
      right.append(el('span', 'sl-ft', 'markdown'), el('span', 'sl-pct', pct), el('span', `sl-pos m-${modeKey}`, ` ${line.number}:${s.selection.main.head - line.from + 1} `));
    }
    this.dom.statusline.replaceChildren(left, right);
  }

  private renderDashboard() {
    const items = this.dashboardItems();
    this.dashboardIndex = Math.min(this.dashboardIndex, Math.max(0, items.length - 1));

    const actions = el('div', 'dash-actions');
    const action = (key: string, label: string, run: () => void) => {
      const b = el('button', 'dash-action');
      b.append(el('span', 'dash-icon', '›'), el('span', 'dash-label', label), el('span', 'dash-key', key));
      b.addEventListener('click', run);
      return b;
    };
    actions.append(
      action('n', '新規メモ', () => this.newMemo()),
      action('/', 'メモを検索', () => this.searchPrompt()),
      action('r', '同期', () => void this.refresh()),
      action(':', 'コマンド', () => this.prompt()),
    );

    const query = this.dashboardQuery;
    const list = el('div', 'dash-list');
    list.append(el('div', 'dash-heading', query ? `検索: ${query} (${items.length})` : `メモ (${items.length})`));
    items.forEach((hit, i) => {
      const f = hit.file;
      const row = el('button', 'dash-item' + (i === this.dashboardIndex ? ' selected' : ''));
      const title = el('span', 'dash-title');
      if (query && hit.line) {
        appendHighlighted(title, hit.line, query);
      } else {
        title.textContent = f.text === null ? '(binary)' : memoTitle(f.text) || '(空)';
      }
      row.append(el('span', 'dash-date', formatStamp(f.path) || f.path), title);
      row.title = f.path;
      row.addEventListener('click', () => this.openHit(hit));
      list.append(row);
    });
    if (!items.length) {
      const empty = query ? '一致するメモはありません' : this.sync === 'syncing' ? '読み込み中…' : 'メモがありません';
      list.append(el('div', 'dash-empty', empty));
    }

    const footer = el(
      'div',
      'dash-footer',
      query
        ? '↑/↓ 選択 · Enter 開く · Esc 検索をやめる'
        : 'j/k 移動 · Enter 開く · / 検索 · n 新規 · dd 削除 · r 同期 · q 戻る',
    );
    this.dom.dashboard.replaceChildren(el('pre', 'logo', LOGO), el('div', 'dash-sub', 'memo'), actions, list, footer);
    list.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  }
}

// ------------------------------------------------- vim ex + key mappings

/** Short forms accepted by the dashboard prompt (the editor gets them from defineEx). */
const EX_ALIASES: Record<string, string> = {
  write: 'w', wall: 'wa', quit: 'q', qall: 'qa', xit: 'x', edit: 'e',
  bnext: 'bn', bprevious: 'bp', bdelete: 'bd', buffers: 'ls',
  on: 'only', clo: 'close', winc: 'wincmd',
};

/**
 * With a Japanese IME on, normal-mode keys arrive as the text the IME
 * commits: full-width ASCII (／, ｎ, ：) or Japanese punctuation (・ for /,
 * ー for -). Map them back to the keys Vim expects, via Vim's 'langmap'.
 */
function imeLangmap(): string {
  const escape = (ch: string) => (',;\\'.includes(ch) ? `\\${ch}` : ch);
  const pairs: string[] = [];
  for (let code = 0x21; code <= 0x7e; code++) {
    pairs.push(String.fromCharCode(code + 0xfee0) + escape(String.fromCharCode(code)));
  }
  const punctuation: [string, string][] = [
    ['・', '/'], ['ー', '-'], ['「', '['], ['」', ']'], ['、', ','], ['。', '.'], ['￥', '\\'], ['　', ' '],
  ];
  for (const [from, to] of punctuation) pairs.push(from + escape(to));
  return pairs.join('');
}

let vimConfigured = false;

export function configureVim() {
  if (vimConfigured) return;
  vimConfigured = true;
  const define = (name: string, prefix: string, key = prefix) =>
    Vim.defineEx(name, prefix, (_cm: unknown, params: { argString?: string }) => {
      const raw = params.argString ?? '';
      const bang = raw.startsWith('!');
      app?.ex(key, bang, (bang ? raw.slice(1) : raw).trim());
    });
  define('write', 'w');
  define('wall', 'wa');
  define('quit', 'q');
  define('qall', 'qa');
  define('wq', 'wq');
  define('xit', 'x');
  define('edit', 'e');
  define('new', 'new');
  define('bnext', 'bn');
  define('bprevious', 'bp');
  define('bdelete', 'bd');
  define('ls', 'ls');
  define('buffers', 'buffers', 'ls');
  define('Delete', 'Delete');
  define('Dashboard', 'Dashboard');
  define('Sync', 'Sync');
  define('Logout', 'Logout');
  define('KeyLog', 'KeyLog');
  define('MarkdownPreview', 'MarkdownPreview');
  define('MarkdownPreviewStop', 'MarkdownPreviewStop');
  define('MarkdownPreviewToggle', 'MarkdownPreviewToggle');
  define('wincmd', 'winc');
  define('close', 'clo');
  define('only', 'on');

  // LazyVim-style keymaps (leader = Space).
  Vim.setOption('langmap', imeLangmap());
  // Note: never Vim.unmap a built-in key. noremap expansion locates the
  // built-in keymap by its original length, so removing one makes noremap
  // see a user mapping (p -> "+p then re-expanded and dropped).
  syncYanksToClipboard();
  Vim.map('H', ':bprevious<CR>', 'normal');
  Vim.map('L', ':bnext<CR>', 'normal');
  // <leader> maps live in App.onLeaderKey / LEADER_MAPS.
}
