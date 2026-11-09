/**
 * Turn Android's "back" into Esc, so Esc never closes the app.
 *
 * On Android, Esc on a hardware / Bluetooth keyboard is also the system back
 * key: when the page does not consume the keydown (always the case with the
 * IME on, where it arrives as key "Unidentified" / keyCode 229, often with no
 * `code`), the browser goes back in history, and an installed PWA with no
 * history to go back to closes.
 *
 * So keep a stack of extra history entries on top of the page. When back pops
 * one, run Esc on whatever has focus (the editor, the `:` / `/` prompt, the
 * dashboard) instead.
 *
 * Chrome's history-manipulation intervention makes back *skip* an entry the
 * user never interacted with while it was current — an entry pushed at load,
 * or from popstate, is useless and back would close the app anyway. So
 * entries are only pushed from a tap or key press (with user activation),
 * one per interaction, up to MAX_DEPTH: by the time the user presses Esc a few
 * times in a row there are several real entries to pop.
 */

const MAX_DEPTH = 30;
/** A real Esc keydown within this window already did the work; back only pops. */
const HANDLED_ESC_MS = 500;
const KEY = 'nvimMemoBackDepth';

const depthOf = (state: unknown) => {
  const d = (state as Record<string, unknown> | null)?.[KEY];
  return typeof d === 'number' ? d : 0;
};

export function isEscapeKey(e: KeyboardEvent) {
  return e.key === 'Escape' || e.code === 'Escape' || e.keyCode === 27;
}

export function trapBackKey() {
  let depth = depthOf(history.state);
  let lastEsc = 0;

  /** Push one more entry, only while the page has fresh user activation. */
  const grow = () => {
    if (depth >= MAX_DEPTH) return;
    const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    if (ua && !ua.isActive) return;
    depth += 1;
    history.pushState({ ...(history.state as object | null), [KEY]: depth }, '');
  };

  const sendEscape = () => {
    const target = (document.activeElement as HTMLElement | null) ?? document.body;
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }),
    );
  };

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
  // Activation-triggering events on touch screens (pointerdown is not one).
  for (const type of ['pointerup', 'touchend', 'click', 'input']) {
    window.addEventListener(type, grow, { passive: true });
  }

  window.addEventListener('popstate', (e) => {
    const next = depthOf(e.state);
    const wentBack = next < depth;
    depth = next;
    if (wentBack && Date.now() - lastEsc > HANDLED_ESC_MS) sendEscape();
  });
}
