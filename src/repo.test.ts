import { describe, expect, it } from 'vitest';
import { appendToIndex, memoTitle, newMemoName, normalizeMemoName } from './nb';
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
  it('adds .md when no extension is given', () => {
    expect(normalizeMemoName('todo')).toBe('todo.md');
    expect(normalizeMemoName('todo.txt')).toBe('todo.txt');
  });
});

describe('MemoRepo', () => {
  it('loads files and edits with an nb-style commit', async () => {
    const t = new MockTransport(seed);
    const repo = new MemoRepo(t, memoryStore());
    await repo.refresh();
    expect(repo.get('example.md')?.text).toBe('hello\n');

    expect(await repo.save('example.md', 'hello!\n')).toBe('edited');
    expect(t.log).toEqual(['[nb] Edit: example.md']);
    expect(await t.readFile('example.md')).toBe('hello!\n');
    expect(await t.readFile('.index')).toBe(seed['.index']);
  });

  it('adds a new file and appends it to .index in the same commit', async () => {
    const t = new MockTransport(seed);
    const repo = new MemoRepo(t, memoryStore());
    await repo.refresh();
    expect(await repo.save('20261027100000.md', 'new\n')).toBe('added');
    expect(t.log).toEqual(['[nb] Add: 20261027100000.md']);
    expect(await t.readFile('.index')).toBe(seed['.index'] + '20261027100000.md\n');
    expect(repo.get('20261027100000.md')?.text).toBe('new\n');
  });

  it('skips the commit when nothing changed', async () => {
    const t = new MockTransport(seed);
    const repo = new MemoRepo(t, memoryStore());
    await repo.refresh();
    expect(await repo.save('example.md', 'hello\n')).toBe('unchanged');
    expect(t.log).toEqual([]);
  });

  it('last write wins and keeps files pushed by others', async () => {
    const t = new MockTransport(seed);
    const repo = new MemoRepo(t, memoryStore());
    await repo.refresh();
    // Another machine edits the same file and adds a note after we loaded.
    await t.externalWrite('example.md', 'from terminal\n');
    await t.externalWrite('other.md', 'x\n', '[nb] Add: other.md');

    expect(await repo.save('example.md', 'from web\n')).toBe('edited');
    expect(await t.readFile('example.md')).toBe('from web\n');
    expect(await t.readFile('other.md')).toBe('x\n');
    expect(repo.get('other.md')?.text).toBe('x\n');
  });

  it('retries when the branch moves between commit and push', async () => {
    const t = new MockTransport(seed);
    const repo = new MemoRepo(t, memoryStore());
    await repo.refresh();
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
    expect(await repo.save('example.md', 'mine\n')).toBe('edited');
    expect(t.log).toEqual(['[nb] Add: race.md', '[nb] Edit: example.md']);
    expect(await t.readFile('race.md')).toBe('r\n');
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
