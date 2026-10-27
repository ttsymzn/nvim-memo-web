import { describe, expect, it } from 'vitest';
import { appendToIndex, memoTitle, newMemoName, normalizeMemoName, toEditorText, toFileText } from './nb';
import { MockTransport } from './mock';
import { MemoRepo, type KeyValueStore } from './repo';
import type { Head } from './transport';

function memoryStore(): KeyValueStore {
  const m = new Map<string, unknown>();
  return {
    async get<T>(k: string) {
      return m.get(k) as T | undefined;
    },
    async set(k, v) {
      m.set(k, structuredClone(v));
    },
  };
}

const seed = {
  '.index': 'example.md\n20261025235729.md\n',
  'example.md': 'hello\n',
  '20261025235729.md': '# 買い物\nmilk #todo\n',
};

describe('nb helpers', () => {
  it('names memos from local time', () => {
    expect(newMemoName(new Date(2026, 9, 27, 7, 5, 9))).toBe('20261027070509.md');
  });
  it('appends to .index once, keeping a trailing newline', () => {
    expect(appendToIndex('a.md\nb.md\n', 'c.md')).toBe('a.md\nb.md\nc.md\n');
    expect(appendToIndex('a.md', 'b.md')).toBe('a.md\nb.md\n');
    expect(appendToIndex('', 'a.md')).toBe('a.md\n');
    expect(appendToIndex('a.md\n', 'a.md')).toBe('a.md\n');
  });
  it('titles from heading or first line', () => {
    expect(memoTitle('\n# Title\nbody')).toBe('Title');
    expect(memoTitle('\n  first line\nsecond')).toBe('first line');
  });
  it('hides the final newline while editing and restores it on save', () => {
    expect(toEditorText('a\nb\n')).toBe('a\nb');
    expect(toEditorText('a\nb')).toBe('a\nb');
    expect(toEditorText('a\n\n')).toBe('a\n');
    expect(toEditorText('')).toBe('');
    expect(toFileText('a\nb')).toBe('a\nb\n');
    expect(toFileText('a\n')).toBe('a\n\n');
    expect(toFileText('')).toBe('');
    for (const t of ['x\n', 'x\n\n', '# t\nbody\n']) expect(toFileText(toEditorText(t))).toBe(t);
  });
  it('adds .md when no extension is given', () => {
    expect(normalizeMemoName('todo')).toBe('todo.md');
    expect(normalizeMemoName('todo.txt')).toBe('todo.txt');
  });
});

/**
 * A repo whose transport records which methods MemoRepo calls, in order
 * (each is one or more HTTP requests). Calls the mock makes internally, or
 * that tests make on `t` directly, are not counted.
 */
async function loaded(files: Record<string, string> = seed) {
  const t = new MockTransport(files);
  const calls: string[] = [];
  const counted = new Proxy(t, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return value.apply(target, args);
      };
    },
  });
  const repo = new MemoRepo(counted, memoryStore());
  await repo.refresh();
  calls.length = 0;
  return { t, repo, calls };
}

describe('MemoRepo', () => {
  it('edits an existing memo with a single Contents API request', async () => {
    const { t, repo, calls } = await loaded();
    expect(repo.get('example.md')?.text).toBe('hello\n');

    expect(await repo.save('example.md', 'hello!\n')).toBe('edited');
    expect(calls).toEqual(['putFile']);
    expect(t.log).toEqual(['[nb] Edit: example.md']);
    expect(await t.readFile('example.md')).toBe('hello!\n');
    expect(await t.readFile('.index')).toBe(seed['.index']);
    expect(repo.head?.commit).toBe(t.ref);
    expect(repo.get('example.md')?.text).toBe('hello!\n');
  });

  it('adds a new memo and its .index line in one commit, with three requests', async () => {
    const { t, repo, calls } = await loaded();
    expect(await repo.save('20261027100000.md', 'new\n')).toBe('added');
    // POST tree + POST commit (createCommit) and PATCH ref (updateRef).
    expect(calls).toEqual(['createCommit', 'updateRef']);
    expect(t.log).toEqual(['[nb] Add: 20261027100000.md']);
    expect(await t.readFile('.index')).toBe(seed['.index'] + '20261027100000.md\n');
    expect(repo.get('20261027100000.md')?.text).toBe('new\n');
    expect(repo.head?.commit).toBe(t.ref);
  });

  it('skips the commit when nothing changed, without any request', async () => {
    const { t, repo, calls } = await loaded();
    expect(await repo.save('example.md', 'hello\n')).toBe('unchanged');
    expect(calls).toEqual([]);
    expect(t.log).toEqual([]);
  });

  it('edits in one request even if others pushed other files, and picks those up', async () => {
    const { t, repo, calls } = await loaded();
    await t.externalWrite('other.md', 'x\n', '[nb] Add: other.md');

    expect(await repo.save('example.md', 'from web\n')).toBe('edited');
    expect(calls.slice(0, 1)).toEqual(['putFile']);
    expect(calls).not.toContain('createCommit');
    expect(await t.readFile('example.md')).toBe('from web\n');
    expect(repo.get('other.md')?.text).toBe('x\n');
    expect(repo.head?.commit).toBe(t.ref);
  });

  it('last write wins when the same memo changed remotely', async () => {
    const { t, repo } = await loaded();
    await t.externalWrite('example.md', 'from terminal\n');
    await t.externalWrite('other.md', 'x\n', '[nb] Add: other.md');

    expect(await repo.save('example.md', 'from web\n')).toBe('edited');
    expect(await t.readFile('example.md')).toBe('from web\n');
    expect(await t.readFile('other.md')).toBe('x\n');
    expect(repo.get('other.md')?.text).toBe('x\n');
  });

  it('a new memo on a stale snapshot falls back to fetching and keeps others’ work', async () => {
    const { t, repo, calls } = await loaded();
    await t.externalWrite('race.md', 'r\n', '[nb] Add: race.md');

    expect(await repo.save('20261027100000.md', 'new\n')).toBe('added');
    expect(calls).toEqual(['createCommit', 'updateRef', 'getHead', 'listTree', 'createCommit', 'updateRef', 'getBlobs']);
    expect(t.log).toEqual(['[nb] Add: race.md', '[nb] Add: 20261027100000.md']);
    expect(await t.readFile('race.md')).toBe('r\n');
    expect(await t.readFile('.index')).toBe(seed['.index'] + '20261027100000.md\n');
    expect(repo.get('race.md')?.text).toBe('r\n');
  });

  it('retries when the branch moves between commit and push', async () => {
    const { t, repo } = await loaded();
    const create = t.createCommit.bind(t);
    let raced = false;
    t.createCommit = async (head: Head, changes, message) => {
      const c = await create(head, changes, message);
      if (!raced) {
        raced = true;
        await t.externalWrite('race.md', 'r\n', '[nb] Add: race.md');
      }
      return c;
    };
    expect(await repo.save('20261027100000.md', 'mine\n')).toBe('added');
    expect(t.log).toEqual(['[nb] Add: race.md', '[nb] Add: 20261027100000.md']);
    expect(await t.readFile('race.md')).toBe('r\n');
  });

  it('a memo deleted remotely is saved again as a new one', async () => {
    const { t, repo } = await loaded();
    await t.externalWrite('example.md', null, '[nb] Delete: example.md');
    expect(await repo.save('example.md', 'still here\n')).toBe('added');
    expect(await t.readFile('example.md')).toBe('still here\n');
  });

  it('restores the snapshot from storage', async () => {
    const store = memoryStore();
    const t = new MockTransport(seed);
    await new MemoRepo(t, store).refresh();
    const again = new MemoRepo(t, store);
    expect(await again.loadCache()).toBe(true);
    expect(again.get('20261025235729.md')?.text).toBe(seed['20261025235729.md']);
  });
});
