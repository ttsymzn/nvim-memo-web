import { del, get, set } from 'idb-keyval';
import { App, configureVim } from './app';
import { GitHubTransport } from './github';
import { MockTransport } from './mock';
import { MemoRepo, type KeyValueStore } from './repo';
import type { Transport } from './transport';
import './style.css';

interface Settings {
  token: string;
  owner: string;
  repo: string;
  branch: string;
}

const SETTINGS_KEY = 'settings';
const idbStore: KeyValueStore = { get: (k) => get(k), set: (k, v) => set(k, v) };

const MOCK_FILES: Record<string, string> = {
  '.index': 'example.md\n20261025235729.md\n20261026000310.md\n20261027072916.md\n',
  'example.md': '# example\n\nnvim-memo-web のモックデータです。\n#sample\n',
  '20261025235729.md': '# 買い物リスト\n\n- [ ] 牛乳\n- [ ] パン\n\n#todo #家\n',
  '20261026000310.md': 'Vim の練習メモ\n\n`ciw` で単語を書き換える。`.` で繰り返す。\n#vim\n',
  '20261027072916.md': 'sample 書き込みできますか\n',
};

function start(transport: Transport, store: KeyValueStore, onLogout: () => void) {
  document.getElementById('login')!.hidden = true;
  document.getElementById('app')!.hidden = false;
  configureVim();
  const app = new App(new MemoRepo(transport, store), onLogout);
  void app.start();
  return app;
}

function showLogin(error?: string) {
  const form = document.getElementById('login') as HTMLFormElement;
  const errorEl = document.getElementById('login-error')!;
  form.hidden = false;
  errorEl.textContent = error ?? '';
  const token = form.elements.namedItem('token') as HTMLInputElement;
  token.focus();

  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const [owner, repo] = String(data.get('repo')).trim().split('/');
    const settings: Settings = {
      token: String(data.get('token')).trim(),
      owner,
      repo,
      branch: String(data.get('branch')).trim() || 'main',
    };
    if (!settings.token || !owner || !repo) {
      errorEl.textContent = 'token と owner/repo を入力してください';
      return;
    }
    errorEl.textContent = '接続を確認しています…';
    const transport = new GitHubTransport(settings.token, owner, repo, settings.branch);
    try {
      await transport.getHead();
    } catch (err) {
      errorEl.textContent = `接続できませんでした: ${(err as Error).message}`;
      return;
    }
    await set(SETTINGS_KEY, settings);
    token.value = '';
    start(transport, idbStore, logout);
  };
}

async function logout() {
  await del(SETTINGS_KEY);
  location.reload();
}

async function main() {
  if (new URLSearchParams(location.search).has('mock')) {
    const transport = new MockTransport(MOCK_FILES);
    // Exposed for poking at the fake remote from devtools, e.g. __mock.externalWrite('x.md', 'hi')
    (window as unknown as { __mock: MockTransport }).__mock = transport;
    // An in-memory clipboard, so y/p can be exercised without permission prompts.
    // `__clipboard.text = '…'` simulates copying in another app.
    const fakeClipboard = {
      text: '',
      async writeText(t: string) {
        fakeClipboard.text = t;
      },
      async readText() {
        return fakeClipboard.text;
      },
    };
    Object.defineProperty(navigator, 'clipboard', { value: fakeClipboard, configurable: true });
    (window as unknown as { __clipboard: typeof fakeClipboard }).__clipboard = fakeClipboard;
    const memory = new Map<string, unknown>();
    const store: KeyValueStore = {
      get: async <T>(k: string) => memory.get(k) as T | undefined,
      set: async (k, v) => void memory.set(k, v),
    };
    start(transport, store, () => location.reload());
    return;
  }
  const settings = await get<Settings>(SETTINGS_KEY);
  if (!settings) return showLogin();
  start(new GitHubTransport(settings.token, settings.owner, settings.repo, settings.branch), idbStore, logout);
}

void main();
