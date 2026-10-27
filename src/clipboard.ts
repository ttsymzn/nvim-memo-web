import { Prec, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { Vim, getCM } from '@replit/codemirror-vim';

interface Register {
  linewise: boolean;
  setText(text: string, linewise?: boolean, blockwise?: boolean): void;
  toString(): string;
}

interface RegisterController {
  registers: Record<string, Register>;
  pushText(name: string | undefined, operator: string, text: string, linewise?: boolean, blockwise?: boolean): void;
  isValidRegister(name: unknown): boolean;
}

const controller = () => Vim.getRegisterController() as RegisterController;

/**
 * Neovim's `clipboard=unnamedplus` (LazyVim's default), part 1: yanks and
 * deletes into the unnamed register also go to the system clipboard.
 * Call once, after codemirror-vim is loaded.
 */
export function syncYanksToClipboard() {
  const clipboard = navigator.clipboard;
  if (!clipboard) return; // insecure context: keep the in-editor registers only

  const c = controller();
  const pushText = c.pushText.bind(c);
  c.pushText = (name, operator, text, linewise, blockwise) => {
    pushText(name, operator, text, linewise, blockwise);
    // Only the unnamed register is shared, as in Neovim; "a, "_ and "+ keep their own behavior.
    if (name !== '"' && c.isValidRegister(name)) return;
    clipboard.writeText(c.registers['"'].toString()).catch(() => {
      // Not focused or denied: the unnamed register still holds the text for p.
    });
  };
}

/**
 * Part 2: p / P without a register paste the system clipboard. The clipboard
 * can only be read asynchronously, so hold the key, load the clipboard into
 * the unnamed register, then hand the key to Vim. Counts (3p) and visual-mode
 * p keep working because Vim's pending input state is left untouched.
 */
export function pasteFromClipboard(): Extension {
  return Prec.highest(
    EditorView.domEventHandlers({
      keydown(e, view) {
        const clipboard = navigator.clipboard;
        const cm = getCM(view);
        const vim = cm?.state.vim;
        if (!clipboard || !cm || !vim || vim.insertMode) return false;
        if ((e.key !== 'p' && e.key !== 'P') || e.ctrlKey || e.altKey || e.metaKey) return false;
        // "ap, or p as the argument of f/t/r/m: leave it to Vim.
        if (vim.inputState.registerName || vim.inputState.keyBuffer.length || vim.inputState.operator) return false;

        e.preventDefault();
        const key = e.key;
        clipboard
          .readText()
          .then((text) => {
            const unnamed = controller().registers['"'];
            // Text copied in another app: Neovim pastes it linewise when it ends in a newline.
            if (text && text !== unnamed.toString()) unnamed.setText(text, text.endsWith('\n'));
          })
          .catch(() => {
            // Permission denied or not focused: paste the last yank instead.
          })
          .finally(() => Vim.handleKey(cm, key, 'user'));
        return true;
      },
    }),
  );
}
