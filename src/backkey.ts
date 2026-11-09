/**
 * Turn Android's "back" into Esc, so Esc never closes the app.
 *
 * On Android, Esc on a hardware / Bluetooth keyboard is also the system back
 * key, and back in an installed PWA with nothing to go back to closes the app.
 *
 * - CloseWatcher (Chrome 120+) is the platform API for exactly this: while one
 *   is active, Android's back (button, gesture, or Esc-as-back) fires its
 *   `close` event instead of leaving the page. Run Esc then, and make a new
 *   watcher for the next press.
 * - Without CloseWatcher, fall back to a stack of history entries that back
 *   pops. Chrome makes back skip entries the user never interacted with, so
 *   they are only pushed from taps and key presses.
 *
 * Every key / back event is also written to a small log in localStorage that
 * survives the app closing; `:KeyLog` shows it.
 */

/** A real Esc keydown within this window already did the work; back does nothing more. */
const HANDLED_ESC_MS = 500;
const MAX_DEPTH = 30;
const DEPTH_KEY = 'nvimMemoBackDepth';
const LOG_KEY = 'nvim-memo-keylog';
const LOG_LINES = 40;

interface CloseWatcherLike extends EventTarget {
  destroy(): void;
}
type CloseWatcherCtor = new () => CloseWatcherLike;

export function isEscapeKey(e: KeyboardEvent) {
  return e.key === 'Escape' || e.code === 'Escape' || e.keyCode === 27;
}

// ------------------------------------------------------------------ log

function log(line: string) {
  try {
    const now = new Date();
    const t = `${now.toTimeString().slice(0, 8)}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    const lines = (localStorage.getItem(LOG_KEY) ?? '').split('\n').filter(Boolean);
    lines.push(`${t} ${line}`);
    localStorage.setItem(LOG_KEY, lines.slice(-LOG_LINES).join('\n'));
  } catch {
    // Storage unavailable: logging is best effort.
  }
}

/** The recorded key / back events, oldest first (for `:KeyLog`). */
export function keyLog(): string {
  try {
    return localStorage.getItem(LOG_KEY) || '（記録なし）';
  } catch {
    return '（localStorage が使えません）';
  }
}

export function clearKeyLog() {
  try {
    localStorage.removeItem(LOG_KEY);
  } catch {
    // ignore
  }
}

// ----------------------------------------------------------------- trap

export function trapBackKey() {
  let lastEsc = 0;

  const sendEscape = (why: string) => {
    if (Date.now() - lastEsc < HANDLED_ESC_MS) return log(`${why}: Esc は処理済み`);
    const target = (document.activeElement as HTMLElement | null) ?? document.body;
    log(`${why}: Esc を送る → ${target.tagName.toLowerCase()}${target.className ? '.' + target.className.split(' ')[0] : ''}`);
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }),
    );
  };

  const CW = (window as unknown as { CloseWatcher?: CloseWatcherCtor }).CloseWatcher;
  const grow = CW ? watchClose(CW, sendEscape) : historyTrap(sendEscape);
  log(`起動: ${CW ? 'CloseWatcher' : 'history'} 方式, history.length=${history.length}, ${navigator.userAgent.replace(/^.*?\(/, '(')}`);

  window.addEventListener(
    'keydown',
    (e) => {
      // Special keys only (Esc, Unidentified, Process, ...): never the text being typed.
      if (!e.isTrusted || e.key.length === 1) return;
      // Capture phase: record what arrived before anything handles it.
      log(`keydown key=${e.key} code=${e.code || '-'} keyCode=${e.keyCode}${e.isComposing ? ' composing' : ''}`);
    },
    true,
  );
  window.addEventListener('keydown', (e) => {
    if (!e.isTrusted) return;
    if (isEscapeKey(e)) {
      lastEsc = Date.now();
      // Whatever handled it (or nothing did): Esc must not fall through to "back".
      // Bubble phase, since CodeMirror ignores events already defaultPrevented.
      e.preventDefault();
    } else {
      grow();
    }
  });
  for (const type of ['pointerup', 'touchend', 'click', 'input']) {
    window.addEventListener(type, grow, { passive: true });
  }
  window.addEventListener('pagehide', () => log('pagehide（アプリを離れた）'));
  document.addEventListener('visibilitychange', () => log(`visibility=${document.visibilityState}`));
}

/** CloseWatcher: one active watcher at a time; back closes it and we make the next. */
function watchClose(CW: CloseWatcherCtor, sendEscape: (why: string) => void) {
  let watcher: CloseWatcherLike | null = null;
  const make = () => {
    try {
      watcher = new CW();
    } catch (err) {
      watcher = null;
      log(`CloseWatcher 作成失敗: ${(err as Error).message}`);
      return;
    }
    watcher.addEventListener('cancel', (e) => {
      // Keep the watcher (it stays active) when the browser lets us.
      log(`CloseWatcher cancel (cancelable=${e.cancelable})`);
      if (e.cancelable) {
        e.preventDefault();
        sendEscape('戻る');
      }
    });
    watcher.addEventListener('close', () => {
      log('CloseWatcher close');
      watcher = null;
      sendEscape('戻る');
      make();
    });
  };
  make();
  // Re-create a watcher the browser destroyed (e.g. creation failed earlier).
  return () => {
    if (!watcher) make();
  };
}

/** Fallback: history entries pushed on user interaction, popped by back. */
function historyTrap(sendEscape: (why: string) => void) {
  const depthOf = (state: unknown) => {
    const d = (state as Record<string, unknown> | null)?.[DEPTH_KEY];
    return typeof d === 'number' ? d : 0;
  };
  let depth = depthOf(history.state);

  window.addEventListener('popstate', (e) => {
    const next = depthOf(e.state);
    const wentBack = next < depth;
    log(`popstate depth ${depth}→${next}`);
    depth = next;
    if (wentBack) sendEscape('戻る');
  });

  return () => {
    if (depth >= MAX_DEPTH) return;
    const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    if (ua && !ua.isActive) return;
    depth += 1;
    history.pushState({ ...(history.state as object | null), [DEPTH_KEY]: depth }, '');
  };
}
