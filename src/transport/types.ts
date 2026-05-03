// Transport abstraction shared by every milestone that touches the host.
//
// Two concrete implementations:
//   • SshTransport  — shells out to the system ssh client; honors ~/.ssh/config.
//   • LocalTransport — spawns a local /bin/sh -c on the same host the
//                      extension is running on. Used when Positron is in
//                      Remote SSH mode against the NONMEM host (no extra
//                      ssh hop needed).
//
// pickTransport() in ./factory.ts picks one based on the user's
// `positronNonmem.host.transport` setting and an auto-detect heuristic
// that compares os.hostname() with the HostName resolved by ssh -G.

export class TransportError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

export interface CommandResult {
  /** Exit code of the remote / local command. null if interrupted. */
  code: number | null;
  stdout: string;
  /** stderr, with hostname scrubbed if applicable to the transport. */
  stderr: string;
}

/** Subset of POSIX file types we surface via Transport.stat. */
export type RemoteFileType = 'file' | 'directory' | 'symlink';

export interface RemoteFileStat {
  type: RemoteFileType;
  /** File size in bytes; 0 for non-regular files. */
  size: number;
  /** Modification time as Unix epoch seconds. 0 if unknown. */
  mtime: number;
}

export interface RemoteDirEntry {
  name: string;
  type: RemoteFileType;
}

export class RemoteFileNotFoundError extends Error {
  constructor(public readonly remotePath: string) {
    super(`remote file not found: ${remotePath}`);
    this.name = 'RemoteFileNotFoundError';
  }
}

export interface Transport {
  /** Short label for logging surfaces; never includes the resolved hostname. */
  readonly kind: 'ssh' | 'local';

  /** Run a single command. */
  run(command: string): Promise<CommandResult>;

  /**
   * Upload a local file to a remote path. For LocalTransport this is a
   * plain `fs.copyFile`. Remote paths starting with `~/` are expanded
   * against the user's home directory on the side that owns the file
   * system being written to (i.e. for SSH, the remote shell's HOME; for
   * LOCAL, os.homedir()).
   */
  putFile(localPath: string, remotePath: string): Promise<void>;

  /** Download a remote file to a local path. Mirror of putFile. */
  getFile(remotePath: string, localPath: string): Promise<void>;

  /**
   * Write `content` (UTF-8) directly to a remote path. Use when the
   * payload is generated in-memory (e.g. `manifest.json`) and we don't
   * want to round-trip through a local temp file. Parent directory must
   * already exist (callers typically `mkdir -p` it via `run` first).
   */
  writeFile(remotePath: string, content: string): Promise<void>;

  /**
   * Read a remote text file into memory. Mirror of writeFile. Returns
   * the UTF-8 content. Throws RemoteFileNotFoundError on missing path
   * so callers can distinguish "not there yet" from real I/O errors.
   */
  readFile(remotePath: string): Promise<string>;

  /**
   * Stat a remote path. Throws RemoteFileNotFoundError when absent so
   * the FileSystemProvider can map cleanly to vscode.FileSystemError.FileNotFound.
   */
  stat(remotePath: string): Promise<RemoteFileStat>;

  /**
   * List the immediate children of a remote directory. Order is
   * unspecified; symlinks are NOT followed. Throws RemoteFileNotFoundError
   * on missing path.
   */
  readDirectory(remotePath: string): Promise<RemoteDirEntry[]>;
}
