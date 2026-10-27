import type { FileChange, Head, Transport, TreeEntry } from './transport';

interface MockCommit {
  tree: string;
  parent: string | null;
  message: string;
}

/** In-memory repository used with `?mock` and in tests. */
export class MockTransport implements Transport {
  readonly label = 'mock/nvim-memo@main';
  blobs = new Map<string, string>();
  trees = new Map<string, TreeEntry[]>();
  commits = new Map<string, MockCommit>();
  ref: string;
  /** Commit messages in push order, for inspection in tests and the console. */
  log: string[] = [];
  private seq = 0;

  constructor(files: Record<string, string> = {}) {
    const entries = Object.entries(files).map(([path, text]) => ({ path, sha: this.writeBlob(text) }));
    this.ref = this.writeCommit(this.writeTree(entries), null, '[nb] Initialize');
  }

  private id(prefix: string) {
    return `${prefix}${(++this.seq).toString(16).padStart(8, '0')}`;
  }
  private writeBlob(text: string) {
    const sha = this.id('b');
    this.blobs.set(sha, text);
    return sha;
  }
  private writeTree(entries: TreeEntry[]) {
    const sha = this.id('t');
    this.trees.set(sha, entries);
    return sha;
  }
  private writeCommit(tree: string, parent: string | null, message: string) {
    const sha = this.id('c');
    this.commits.set(sha, { tree, parent, message });
    return sha;
  }

  async getHead(): Promise<Head> {
    return { commit: this.ref, tree: this.commits.get(this.ref)!.tree };
  }

  async listTree(tree: string): Promise<TreeEntry[]> {
    return [...this.trees.get(tree)!];
  }

  async getBlobs(shas: string[]) {
    return new Map(shas.map((s) => [s, this.blobs.get(s) ?? null] as const));
  }

  async createCommit(head: Head, changes: FileChange[], message: string): Promise<Head> {
    const entries = new Map(this.trees.get(head.tree)!.map((e) => [e.path, e.sha]));
    for (const c of changes) {
      if (c.content === null) entries.delete(c.path);
      else entries.set(c.path, this.writeBlob(c.content));
    }
    const tree = this.writeTree([...entries].map(([path, sha]) => ({ path, sha })));
    return { commit: this.writeCommit(tree, head.commit, message), tree };
  }

  async updateRef(commit: string): Promise<boolean> {
    const c = this.commits.get(commit)!;
    if (c.parent !== this.ref) return false;
    this.ref = commit;
    this.log.push(c.message);
    return true;
  }

  /** Simulate a push from another machine (e.g. `nb sync` in a terminal). */
  async externalWrite(path: string, content: string | null, message = `[nb] Edit: ${path}`) {
    const next = await this.createCommit(await this.getHead(), [{ path, content }], message);
    await this.updateRef(next.commit);
  }

  async readFile(path: string): Promise<string | undefined> {
    const entry = this.trees.get((await this.getHead()).tree)!.find((e) => e.path === path);
    return entry && this.blobs.get(entry.sha);
  }
}
