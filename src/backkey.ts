/**
 * Turn Android's "back" into Esc.
 *
 * On Android, Esc on a hardware / Bluetooth keyboard is also the system back
 * key. When the page does not consume the keydown (always the case while an
 * IME is on: it arrives as key "Unidentified" / keyCode 229), the browser goes
 * back in history, and an installed PWA with no history simply closes — so Esc
 * quit the app instead of returning to Normal mode.
 *
 * Keep one extra history entry on top. When back pops it, run Esc on whatever
 * has focus (the editor, the `:` / `/` prompt, the dashboard) and put the entry
 * back. Chrome skips history entries that were added without a user gesture,
 * so the entry is (re-)added on the next key press or tap, never from popstate.
 */

/** A real Esc keydown within this window already did the work; back only re-arms. */
const HANDLED_ESC_MS = 500;
const MARK = 'nvim-memo-back-trap';

export function trapBackKey() {
  let armed = history.state?.[MARK] === true;
  let lastEsc = 0;

  const arm = () => {
    if (armed) return;
    history.pushState({ ...history.state, [MARK]: true }, '');
    armed = true;
  };

  const sendEscape = () => {
    const target = (document.activeElement as HTMLElement | null) ?? document.body;
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }),
    );
  };

  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted) return;
      if (e.key === 'Escape') {
        lastEsc = Date.now();
        // Vim may have handled Esc without preventDefault; don't let it fall through to "back".
        e.preventDefault();
      } else {
        arm();
      }
    },
    // Bubble phase: CodeMirror ignores events that are already defaultPrevented.
    false,
  );
  // Taps and typing (keydown with the IME on) count as user activation.
  window.addEventListener('pointerdown', arm);
  window.addEventListener('input', arm);

  window.addEventListener('popstate', () => {
    armed = history.state?.[MARK] === true;
    if (armed) return; // went forward onto our entry
    if (Date.now() - lastEsc > HANDLED_ESC_MS) sendEscape();
    arm();
  });

  arm();
}
