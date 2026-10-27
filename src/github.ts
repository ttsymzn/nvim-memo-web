import type { FileChange, Head, PutResult, Transport, TreeEntry } from './transport';

const API = 'https://api.github.com';
const BLOB_BATCH = 100;

/** Base64 of the UTF-8 bytes, as the Contents API expects. */
function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** 401: the token itself was rejected (expired, deleted or mistyped), not just short of permissions. */
export function isAuthError(e: unknown): boolean {
  return e instanceof GitHubError && e.status === 401;
}

export class GitHubTransport implements Transport {
  readonly label: string;

  constructor(
    private token: string,
    private owner: string,
    private repo: string,
    private branch: string,
  ) {
    this.label = `${owner}/${repo}@${branch}`;
  }

  /** Swap in a new token after the old one was rejected, keeping the open session. */
  setToken(token: string) {
    this.token = token;
  }

  private async rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API}/repos/${this.owner}/${this.repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new GitHubError(`${method} ${path}: ${res.status} ${detail.message ?? ''}`.trim(), res.status);
    }
    return res.json() as Promise<T>;
  }

  async getHead(): Promise<Head> {
    // One request: the branch endpoint includes the head commit's tree.
    const branch = await this.rest<{ commit: { sha: string; commit: { tree: { sha: string } } } }>(
      'GET',
      `/branches/${this.branch}`,
    );
    return { commit: branch.commit.sha, tree: branch.commit.commit.tree.sha };
  }

  async listTree(tree: string): Promise<TreeEntry[]> {
    const res = await this.rest<{ tree: { path: string; sha: string; type: string }[] }>(
      'GET',
      `/git/trees/${tree}`,
    );
    return res.tree.filter((e) => e.type === 'blob').map(({ path, sha }) => ({ path, sha }));
  }

  /** Fetch many blobs per request through GraphQL instead of one REST call each. */
  async getBlobs(shas: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    for (let i = 0; i < shas.length; i += BLOB_BATCH) {
      const batch = shas.slice(i, i + BLOB_BATCH);
      const fields = batch
        .map((sha, j) => `b${j}: object(oid: "${sha}") { ... on Blob { text isBinary } }`)
        .join('\n');
      const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`;
      const res = await fetch(`${API}/graphql`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { owner: this.owner, name: this.repo } }),
      });
      const json = await res.json();
      if (!res.ok || json.errors) {
        throw new GitHubError(`GraphQL: ${res.status} ${JSON.stringify(json.errors ?? json.message)}`, res.status);
      }
      batch.forEach((sha, j) => {
        const blob = json.data.repository[`b${j}`];
        out.set(sha, blob && !blob.isBinary ? blob.text : null);
      });
    }
    return out;
  }

  async createCommit(head: Head, changes: FileChange[], message: string) {
    const tree = await this.rest<{ sha: string; tree: { path: string; sha: string; type: string }[] }>('POST', '/git/trees', {
      base_tree: head.tree,
      tree: changes.map((c) =>
        c.content === null
          ? { path: c.path, mode: '100644', type: 'blob', sha: null }
          : { path: c.path, mode: '100644', type: 'blob', content: c.content },
      ),
    });
    const commit = await this.rest<{ sha: string }>('POST', '/git/commits', {
      message,
      tree: tree.sha,
      parents: [head.commit],
    });
    const entries = tree.tree.filter((e) => e.type === 'blob').map(({ path, sha }) => ({ path, sha }));
    return { head: { commit: commit.sha, tree: tree.sha }, entries };
  }

  async putFile(path: string, content: string, message: string, sha: string): Promise<PutResult | null> {
    try {
      const res = await this.rest<{
        content: { sha: string };
        commit: { sha: string; tree: { sha: string }; parents: { sha: string }[] };
      }>('PUT', `/contents/${encodeURIComponent(path)}`, { message, content: base64(content), sha, branch: this.branch });
      return {
        head: { commit: res.commit.sha, tree: res.commit.tree.sha },
        parent: res.commit.parents[0]?.sha ?? '',
        blobSha: res.content.sha,
      };
    } catch (e) {
      // 409: the file's sha no longer matches; 422: e.g. the file was deleted.
      if (e instanceof GitHubError && (e.status === 409 || e.status === 422)) return null;
      throw e;
    }
  }

  async updateRef(commit: string): Promise<boolean> {
    try {
      await this.rest('PATCH', `/git/refs/heads/${this.branch}`, { sha: commit, force: false });
      return true;
    } catch (e) {
      // 422 "Update is not a fast forward": someone else pushed first.
      if (e instanceof GitHubError && e.status === 422) return false;
      throw e;
    }
  }
}
