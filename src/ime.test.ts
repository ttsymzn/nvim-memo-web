import { describe, expect, it } from 'vitest';
import { ImeTracker } from './ime';

const key = (type: 'keydown' | 'keyup', key: string, code: string, keyCode = 0) =>
  ({ type, key, code, keyCode, ctrlKey: false, altKey: false, metaKey: false, repeat: false });
const press = (t: ImeTracker, down: [string, string, number?], up: [string, string, number?] = down) => [
  t.key(key('keydown', down[0], down[1], down[2])),
  t.key(key('keyup', up[0], up[1], up[2])),
];

describe('ImeTracker', () => {
  it('Windows 半角/全角 says which mode it leaves', () => {
    const t = new ImeTracker();
    expect(press(t, ['Hankaku', 'Backquote', 243])).toEqual([true, null]);
    expect(press(t, ['Zenkaku', 'Backquote', 244])).toEqual([false, null]);
  });

  it('decides on keyup when the IME swallows the keydown', () => {
    const t = new ImeTracker();
    t.on = true;
    expect(press(t, ['Process', 'Backquote', 229], ['Zenkaku', 'Backquote', 244])).toEqual([null, false]);
    expect(press(t, ['Process', 'Backquote', 229], ['Hankaku', 'Backquote', 243])).toEqual([null, true]);
    // Neither event names the key: flip the last known state.
    expect(press(t, ['Process', 'Backquote', 229])).toEqual([null, false]);
  });

  it('a ` typed into the IME is not a switch', () => {
    const t = new ImeTracker();
    t.on = true;
    expect(press(t, ['Process', 'Backquote', 229], ['`', 'Backquote', 192])).toEqual([null, null]);
    expect(t.on).toBe(true);
  });

  it('Mac かな / 英数 and Linux toggles', () => {
    const t = new ImeTracker();
    expect(press(t, ['Lang1', 'Lang1'])).toEqual([true, null]);
    expect(press(t, ['Lang2', 'Lang2'])).toEqual([false, null]);
    expect(press(t, ['ZenkakuHankaku', 'Backquote'])).toEqual([true, null]);
    expect(press(t, ['ZenkakuHankaku', 'Backquote'])).toEqual([false, null]);
  });

  it('learns the state from ordinary keys for the next toggle', () => {
    const t = new ImeTracker();
    press(t, ['Process', 'KeyA', 229], ['a', 'KeyA']);
    expect(t.on).toBe(true);
    expect(press(t, ['ZenkakuHankaku', 'Backquote'])).toEqual([false, null]);
    press(t, ['a', 'KeyA']);
    expect(t.on).toBe(false);
  });

  it('trusts typed keys over the 半角/全角 key name once they disagree', () => {
    const t = new ImeTracker();
    // Insert mode, typing Japanese: the IME is on.
    press(t, ['Process', 'KeyA', 229], ['a', 'KeyA']);
    // The key's alternation is out of step and says "turning on": it really turns off.
    expect(press(t, ['Hankaku', 'Backquote', 243])).toEqual([false, null]);
    // Normal mode, `j` arrives as itself: off. The key says "turning off": it really turns on.
    press(t, ['j', 'KeyJ']);
    expect(press(t, ['Zenkaku', 'Backquote', 244])).toEqual([true, null]);
  });

  it('falls back to the key name after focus left', () => {
    const t = new ImeTracker();
    press(t, ['Process', 'KeyA', 229], ['a', 'KeyA']);
    t.forget();
    expect(press(t, ['Hankaku', 'Backquote', 243])).toEqual([true, null]);
  });
});
