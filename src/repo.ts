import { INDEX_FILE, appendToIndex } from './nb';
import type { FileChange, Head, Transport, TreeEntry } from './transport';

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export interface MemoFile {
  path: string;
  sha: string;
  /** null when the blob is binary. */
  text: string | null;
}

export type SaveResult = 'added' | 'edited' | 'unchanged';

interface CacheShape {
  head: Head;
  entries: TreeEntry[];
  blobs: [string, string | null][];
}

const MAX_PUSH_ATTEMPTS = 5;

/**
 * The working copy of the memo repository: a cached snapshot of `main`
 * plus the logic to commit edits on top of whatever is current remotely.
 */
export class MemoRepo {
  head: Head | null = null;
  private entries: TreeEntry[] = [];
  private blobs = new Map<string, string | null>();
  private listeners = new Set<(changed: string[]) => void>();

  constructor(
    readonly transport: Transport,
    private store: KeyValueStore,
  ) {}

  private get cacheKey() {
    return `repo:${this.transport.label}`;
  }

  onChange(fn: (changed: string[]) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  files(): MemoFile[] {
    return this.entries.map((e) => ({ ...e, text: this.blobs.get(e.sha) ?? null }));
  }

  get(path: string): MemoFile | undefined {
    const e = this.entries.find((x) => x.path === path);
    return e && { ...e, text: this.blobs.get(e.sha) ?? null };
  }

  /** Restore the last snapshot from browser storage. Returns false if none. */
  async loadCache(): Promise<boolean> {
    const cached = await this.store.get<CacheShape>(this.cacheKey);
    if (!cached) return false;
    this.head = cached.head;
    this.entries = cached.entries;
    this.blobs = new Map(cached.blobs);
    return true;
  }

  /** Pull the latest `main`. Returns the paths whose content changed. */
  async refresh(): Promise<string[]> {
    const head = await this.transport.getHead();
    if (this.head?.commit === head.commit) return [];
    const entries = await this.transport.listTree(head.tree);
    return this.adopt(head, entries);
  }

  private async adopt(head: Head, entries: TreeEntry[]): Promise<string[]> {
    const missing = entries.map((e) => e.sha).filter((sha) => !this.blobs.has(sha));
    if (missing.length) {
      for (const [sha, text] of await this.transport.getBlobs(missing)) this.blobs.set(sha, text);
    }
    const before = new Map(this.entries.map((e) => [e.path, e.sha]));
    const changed = entries.filter((e) => before.get(e.path) !== e.sha).map((e) => e.path);
    const after = new Set(entries.map((e) => e.path));
    for (const path of before.keys()) if (!after.has(path)) changed.push(path);

    this.head = head;
    this.entries = entries;
    // Keep only blobs that the current tree references.
    const live = new Set(entries.map((e) => e.sha));
    for (const sha of [...this.blobs.keys()]) if (!live.has(sha)) this.blobs.delete(sha);
    await this.persist();
    if (changed.length) this.listeners.forEach((fn) => fn(changed));
    return changed;
  }

  private async persist() {
    if (!this.head) return;
    const cache: CacheShape = { head: this.head, entries: this.entries, blobs: [...this.blobs] };
    await this.store.set(this.cacheKey, cache);
  }

  private async blobText(sha: string): Promise<string | null> {
    if (!this.blobs.has(sha)) {
      const fetched = await this.transport.getBlobs([sha]);
      this.blobs.set(sha, fetched.get(sha) ?? null);
    }
    return this.blobs.get(sha) ?? null;
  }

  /**
   * Commit `text` as `path` on top of the current remote `main`.
   * Last write wins: if someone pushed in between, rebuild on their commit
   * and push our content again.
   */
  async save(path: string, text: string): Promise<SaveResult> {
    for (let attempt = 0; attempt < MAX_PUSH_ATTEMPTS; attempt++) {
      const head = await this.transport.getHead();
      const entries = await this.transport.listTree(head.tree);
      const existing = entries.find((e) => e.path === path);

      if (existing && (await this.blobText(existing.sha)) === text) {
        await this.adopt(head, entries);
        return 'unchanged';
      }

      const changes: FileChange[] = [{ path, content: text }];
      if (!existing) {
        const index = entries.find((e) => e.path === INDEX_FILE);
        const indexText = index ? ((await this.blobText(index.sha)) ?? '') : '';
        changes.push({ path: INDEX_FILE, content: appendToIndex(indexText, path) });
      }
      const message = `[nb] ${existing ? 'Edit' : 'Add'}: ${path}`;

      const next = await this.transport.createCommit(head, changes, message);
      if (!(await this.transport.updateRef(next.commit))) continue;

      const nextEntries = await this.transport.listTree(next.tree);
      for (const c of changes) {
        const sha = nextEntries.find((e) => e.path === c.path)?.sha;
        if (sha) this.blobs.set(sha, c.content);
      }
      await this.adopt(next, nextEntries);
      return existing ? 'edited' : 'added';
    }
    throw new Error(`push failed ${MAX_PUSH_ATTEMPTS} times: the branch keeps moving`);
  }
}
