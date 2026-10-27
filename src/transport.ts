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

export interface PutResult {
  /** The new branch head. */
  head: Head;
  /** Parent of the new commit: differs from the local head when others pushed first. */
  parent: string;
  /** Blob sha of the written file. */
  blobSha: string;
}

export interface Transport {
  readonly label: string;
  getHead(): Promise<Head>;
  listTree(tree: string): Promise<TreeEntry[]>;
  /** Text of each blob; null for binary blobs. */
  getBlobs(shas: string[]): Promise<Map<string, string | null>>;
  /**
   * Create a tree on top of `head.tree` and a commit whose parent is `head.commit`.
   * Also returns the new tree's entries, so callers need not list it again.
   */
  createCommit(head: Head, changes: FileChange[], message: string): Promise<{ head: Head; entries: TreeEntry[] }>;
  /** Fast-forward the branch. Returns false when the branch moved meanwhile. */
  updateRef(commit: string): Promise<boolean>;
  /**
   * Overwrite one existing file and commit it on top of the branch in a single
   * request. `sha` is the blob being replaced; returns null when the file
   * changed (or vanished) remotely since.
   */
  putFile(path: string, content: string, message: string, sha: string): Promise<PutResult | null>;
}
