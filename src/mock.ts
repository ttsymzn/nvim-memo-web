import { GitHubError } from './github';
import type { FileChange, Head, PutResult, Transport, TreeEntry } from './transport';

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
  /** Set to true (e.g. `__mock.tokenRevoked = true`) to answer every request with 401 Bad credentials. */
  tokenRevoked = false;
  private seq = 0;

  setToken() {
    this.tokenRevoked = false;
  }

  private checkToken() {
    if (this.tokenRevoked) throw new GitHubError('GET /branches/main: 401 Bad credentials', 401);
  }

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
    this.checkToken();
    return { commit: this.ref, tree: this.commits.get(this.ref)!.tree };
  }

  async listTree(tree: string): Promise<TreeEntry[]> {
    this.checkToken();
    return [...this.trees.get(tree)!];
  }

  async getBlobs(shas: string[]) {
    this.checkToken();
    return new Map(shas.map((s) => [s, this.blobs.get(s) ?? null] as const));
  }

  async createCommit(head: Head, changes: FileChange[], message: string) {
    this.checkToken();
    const map = new Map(this.trees.get(head.tree)!.map((e) => [e.path, e.sha]));
    for (const c of changes) {
      if (c.content === null) map.delete(c.path);
      else map.set(c.path, this.writeBlob(c.content));
    }
    const entries = [...map].map(([path, sha]) => ({ path, sha }));
    const tree = this.writeTree(entries);
    return { head: { commit: this.writeCommit(tree, head.commit, message), tree }, entries: [...entries] };
  }

  async putFile(path: string, content: string, message: string, sha: string): Promise<PutResult | null> {
    this.checkToken();
    const current = await this.getHead();
    // Like the Contents API: refuse when the file is not at the blob the caller saw.
    if (this.trees.get(current.tree)!.find((e) => e.path === path)?.sha !== sha) return null;
    const next = await this.createCommit(current, [{ path, content }], message);
    await this.updateRef(next.head.commit);
    const blobSha = next.entries.find((e) => e.path === path)!.sha;
    return { head: next.head, parent: current.commit, blobSha };
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
    await this.updateRef(next.head.commit);
  }

  async readFile(path: string): Promise<string | undefined> {
    const entry = this.trees.get((await this.getHead()).tree)!.find((e) => e.path === path);
    return entry && this.blobs.get(entry.sha);
  }
}
