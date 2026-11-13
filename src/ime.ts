/**
 * Track whether the Japanese IME is on, from the keys that switch it.
 *
 * Browsers have no API for the IME's on/off state, so it is inferred:
 *
 * - Ordinary character keys show the current state: the IME swallows them
 *   ("Process", 229) only while it is on. This is the most reliable evidence.
 * - Windows' 半角/全角 key alternates between "Hankaku" (VK_OEM_AUTO, 243)
 *   and "Zenkaku" (VK_OEM_ENLW, 244) on each press. That alternation is the
 *   keyboard's, not the IME's: once the IME is switched some other way
 *   (another app, Ctrl+Space, the mouse) it is out of step. So the key only
 *   flips the observed state; the name decides only while nothing has been
 *   observed ("Hankaku": off → on, "Zenkaku": on → off). The IME may also
 *   swallow the keydown ("Process", code "Backquote"); then keyup completes it.
 * - Mac's かな / 英数 keys say which way they go ("Lang1"/"KanaMode",
 *   "Lang2"/"Eisu"/"Alphanumeric").
 * - Linux's "ZenkakuHankaku" and "KanjiMode" (Alt+半角/全角) only toggle.
 */

type Key = Pick<KeyboardEvent, 'type' | 'key' | 'code' | 'keyCode' | 'ctrlKey' | 'altKey' | 'metaKey' | 'repeat'>;

/** IME switch keys that turn it on. */
const ON_KEYS = new Set(['Lang1', 'KanaMode', 'HiraganaKatakana', 'Hiragana', 'Katakana']);
/** IME switch keys that turn it off. */
const OFF_KEYS = new Set(['Lang2', 'Eisu', 'Alphanumeric']);
/** IME switch keys that only toggle. */
const TOGGLE_KEYS = new Set(['ZenkakuHankaku', 'KanjiMode']);

const isProcess = (e: Key) => e.key === 'Process' || e.keyCode === 229;

/** Which way an IME switch key goes, or null if `e` is not one. */
function switchOf(e: Key, known: boolean): 'on' | 'off' | 'toggle' | null {
  if (e.key === 'Hankaku') return known ? 'toggle' : 'on';
  if (e.key === 'Zenkaku') return known ? 'toggle' : 'off';
  if (ON_KEYS.has(e.key) || e.code === 'Lang1') return 'on';
  if (OFF_KEYS.has(e.key) || e.code === 'Lang2') return 'off';
  if (TOGGLE_KEYS.has(e.key)) return 'toggle';
  return null;
}

export class ImeTracker {
  /** Last known IME state. */
  on = false;
  /** `on` was observed (or derived from an observation), not guessed. */
  known = false;
  /** This press's keydown already switched (so its keyup does nothing). */
  private handled = false;
  /** 半角/全角 swallowed by the IME on keydown: keyup decides. */
  private pending = false;

  /**
   * Feed every keydown / keyup. Returns the new IME state when `e` switched
   * it on or off, otherwise null.
   */
  key(e: Key): boolean | null {
    if (e.repeat) return null;
    const dir = switchOf(e, this.known);
    if (e.type === 'keydown') {
      this.pending = false;
      this.handled = false;
      if (dir) {
        this.handled = true;
        return this.set(dir);
      }
      if (e.code === 'Backquote' && isProcess(e) && !e.ctrlKey && !e.metaKey) {
        // Either 半角/全角, or ` typed into the IME on a US layout: wait for keyup.
        this.pending = true;
        return null;
      }
      const state = stateFromCharKey(e);
      if (state !== null) this.observe(state);
      return null;
    }
    // keyup: some browsers only report the switch key here.
    if (this.handled) {
      if (dir) this.handled = false;
      return null;
    }
    if (dir) return this.set(dir);
    if (this.pending && e.code === 'Backquote') {
      this.pending = false;
      // A character key: ` was typed, not 半角/全角.
      if (e.key.length === 1) return null;
      return this.set('toggle');
    }
    return null;
  }

  /** A composition started: the IME is on (and a pending Backquote was a character). */
  composition() {
    this.observe(true);
    this.pending = false;
  }

  /** Focus left: the IME may be switched elsewhere, so forget what was observed. */
  forget() {
    this.known = false;
    this.pending = false;
  }

  private observe(on: boolean) {
    this.on = on;
    this.known = true;
  }

  private set(dir: 'on' | 'off' | 'toggle'): boolean {
    if (dir === 'toggle') this.on = !this.on;
    else this.observe(dir === 'on');
    return this.on;
  }
}

/** The IME state shown by an ordinary character key, or null if it shows nothing. */
function stateFromCharKey(e: Key): boolean | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  if (!/^(Key[A-Z]|Digit\d)$/.test(e.code)) return null;
  if (isProcess(e)) return true;
  if (e.key.length === 1) return false;
  return null;
}
