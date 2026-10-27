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

/** The running editor, kept across a re-login so open buffers survive a rejected token. */
interface Session {
  app: App;
  /** Repository the session works on; null accepts any (the mock). */
  repoKey: string | null;
  /** Check a new token and switch the running session to it. Throws if GitHub rejects it. */
  reauth(settings: Settings): Promise<void>;
}

let session: Session | undefined;

const repoKey = (s: Settings) => `${s.owner}/${s.repo}@${s.branch}`;

function start(transport: Transport, store: KeyValueStore, onLogout: () => void, mock = false): App {
  document.getElementById('login')!.hidden = true;
  document.getElementById('app')!.hidden = false;
  configureVim();
  const app = new App(new MemoRepo(transport, store), onLogout, () => void onAuthError(mock));
  void app.start();
  return app;
}

function startGitHub(settings: Settings) {
  const transport = new GitHubTransport(settings.token, settings.owner, settings.repo, settings.branch);
  session = {
    app: start(transport, idbStore, logout),
    repoKey: repoKey(settings),
    async reauth(next) {
      await new GitHubTransport(next.token, next.owner, next.repo, next.branch).getHead();
      transport.setToken(next.token);
    },
  };
}

/** GitHub answered 401: forget the stored token and ask for a new one, keeping the editor alive. */
async function onAuthError(mock: boolean) {
  if (!mock) {
    // Prefill the repository so the re-login matches this session and keeps it.
    const old = await get<Settings>(SETTINGS_KEY);
    const form = document.getElementById('login') as HTMLFormElement;
    if (old) {
      (form.elements.namedItem('repo') as HTMLInputElement).value = `${old.owner}/${old.repo}`;
      (form.elements.namedItem('branch') as HTMLInputElement).value = old.branch;
    }
    await del(SETTINGS_KEY);
  }
  showLogin(
    'token が無効になりました（401 Bad credentials）。期限切れか削除された可能性があります。' +
      '新しい token で接続してください。開いているメモと未保存の編集はそのまま残ります。',
  );
}

function showLogin(error?: string) {
  const form = document.getElementById('login') as HTMLFormElement;
  const errorEl = document.getElementById('login-error')!;
  document.getElementById('app')!.hidden = true;
  form.hidden = false;
  errorEl.textContent = error ?? '';
  const token = form.elements.namedItem('token') as HTMLInputElement;
  token.value = '';
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

    // Re-login to the same repository: keep the running editor and its unsaved edits.
    if (session && (session.repoKey === null || session.repoKey === repoKey(settings))) {
      try {
        await session.reauth(settings);
      } catch (err) {
        errorEl.textContent = `接続できませんでした: ${(err as Error).message}`;
        return;
      }
      if (session.repoKey !== null) await set(SETTINGS_KEY, settings);
      token.value = '';
      form.hidden = true;
      document.getElementById('app')!.hidden = false;
      session.app.reauthenticated();
      return;
    }

    try {
      await new GitHubTransport(settings.token, owner, repo, settings.branch).getHead();
    } catch (err) {
      errorEl.textContent = `接続できませんでした: ${(err as Error).message}`;
      return;
    }
    await set(SETTINGS_KEY, settings);
    token.value = '';
    // A different repository: start over rather than mixing two repos' buffers.
    if (session) return location.reload();
    startGitHub(settings);
  };
}

async function logout() {
  await del(SETTINGS_KEY);
  location.reload();
}

async function main() {
  const params = new URLSearchParams(location.search);
  if (params.has('mock')) {
    const transport = new MockTransport(MOCK_FILES);
    // ?mock&latency=300 delays each simulated GitHub request by 300ms.
    const latency = Number(params.get('latency') ?? 0);
    const requests: Record<string, number> = { createCommit: 2 }; // POST tree + POST commit
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
    const slow = new Proxy(transport, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (!latency || typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          await new Promise((r) => setTimeout(r, latency * (requests[String(prop)] ?? 1)));
          return value.apply(target, args);
        };
      },
    });
    session = {
      app: start(slow, store, () => location.reload(), true),
      repoKey: null,
      // Any token "works" for the mock: just stop answering 401.
      async reauth() {
        transport.setToken();
      },
    };
    return;
  }
  const settings = await get<Settings>(SETTINGS_KEY);
  if (!settings) return showLogin();
  startGitHub(settings);
}

void main();
