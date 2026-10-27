// Low-level git operations. GitHubTransport talks to the real API;
// MockTransport keeps an in-memory repository for local development.

export interface TreeEntry {
  path: string;
  sha: string;
}

export interface Head {
  commit: string;
  tree: string;
}

export interface FileChange {
  path: string;
  /** New file content, or null to delete the file. */
  content: string | null;
}

export interface Transport {
  readonly label: string;
  getHead(): Promise<Head>;
  listTree(tree: string): Promise<TreeEntry[]>;
  /** Text of each blob; null for binary blobs. */
  getBlobs(shas: string[]): Promise<Map<string, string | null>>;
  /** Create a tree on top of `head.tree` and a commit whose parent is `head.commit`. */
  createCommit(head: Head, changes: FileChange[], message: string): Promise<Head>;
  /** Fast-forward the branch. Returns false when the branch moved meanwhile. */
  updateRef(commit: string): Promise<boolean>;
}
