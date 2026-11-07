// provider.ts — #1267 the thin vscode.FileSystemProvider adapter over the pure
// host-file core. It holds NO transport or route logic (that all lives in the
// vscode-free HostFileClient): it maps amico-host:// URIs → core calls, core
// results → vscode types, and the typed HostFsError → the matching
// vscode.FileSystemError so VS Code renders the honest outcome. In particular a
// HubDown (unreachable host) surfaces as FileSystemError.Unavailable — the honest
// degraded posture — and there is no local-disk path here to fall back to (AC5).
//
// #1441: the URI AUTHORITY becomes the machine. `amico-host://mac-studio/path`
// resolves a per-machine HostFs via the injected resolver (HostFsResolver). The
// existing single-core constructor is preserved for backward compat — a plain
// HostFs is wrapped in a constant resolver.
import * as vscode from "vscode";
import { HostFsError, type HostFs, type HostStat } from "./host_file_client";

/** A factory that resolves a per-machine HostFs core from the URI authority.
 *  `machine === undefined` means no authority (the local/default machine). */
export type HostFsResolver = (machine?: string) => HostFs;

/** Map a HostFsError to the vscode.FileSystemError the editor understands. An
 *  unknown/unexpected error is re-thrown as-is (never swallowed). */
function toFileSystemError(e: unknown, uri: vscode.Uri): Error {
  if (!(e instanceof HostFsError)) return e instanceof Error ? e : new Error(String(e));
  switch (e.code) {
    case "FileNotFound":
      return vscode.FileSystemError.FileNotFound(uri);
    case "FileExists":
      return vscode.FileSystemError.FileExists(uri);
    case "NoPermissions":
      return vscode.FileSystemError.NoPermissions(`${uri.toString()}: ${e.message}`);
    case "IsADirectory":
      return vscode.FileSystemError.FileIsADirectory(uri);
    case "NotADirectory":
      return vscode.FileSystemError.FileNotADirectory(uri);
    case "HubDown":
      // The honest degraded posture — the host is unreachable. VS Code shows it;
      // it is NEVER a silent switch to local files (AC5).
      return vscode.FileSystemError.Unavailable(`${uri.toString()}: fleet host unreachable — ${e.message}`);
    case "RouteAbsent":
      // The host lacks this route (the #1267 host write-route gap). Surfaced as an
      // explicit permission failure — never a fabricated success.
      return vscode.FileSystemError.NoPermissions(
        `${uri.toString()}: host write route not available yet (fleet host-side follow-up, #1267)`,
      );
    default:
      return new Error(`${uri.toString()}: ${e.message}`);
  }
}

function toFileType(t: HostStat["type"]): vscode.FileType {
  return t === "directory" ? vscode.FileType.Directory : vscode.FileType.File;
}

export class AmicoHostFileSystemProvider implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this.emitter.event;

  private readonly resolveCore: HostFsResolver;

  /** Accepts either a single HostFs (backward compat — wrapped in a constant
   *  resolver) or a HostFsResolver for per-machine dispatch (#1441). */
  constructor(coreOrResolver: HostFs | HostFsResolver) {
    if (typeof coreOrResolver === "function") {
      this.resolveCore = coreOrResolver;
    } else {
      this.resolveCore = () => coreOrResolver;
    }
  }

  /** Resolve the machine from the URI authority: empty/undefined → undefined
   *  (the local machine), anything else → the machine id string. */
  private machineOf(uri: vscode.Uri): string | undefined {
    const authority = uri.authority;
    return authority && authority !== "" ? authority : undefined;
  }

  // We do not watch the host filesystem (no host-push channel in this slice);
  // our own mutations fire onDidChangeFile so the Explorer refreshes.
  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    try {
      const core = this.resolveCore(this.machineOf(uri));
      const st = await core.stat(uri.path);
      return { type: toFileType(st.type), ctime: 0, mtime: 0, size: st.size };
    } catch (e) {
      throw toFileSystemError(e, uri);
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    try {
      const core = this.resolveCore(this.machineOf(uri));
      const entries = await core.readDirectory(uri.path);
      return entries.map((e) => [e.name, toFileType(e.type)]);
    } catch (e) {
      throw toFileSystemError(e, uri);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    try {
      const core = this.resolveCore(this.machineOf(uri));
      return await core.readFile(uri.path);
    } catch (e) {
      throw toFileSystemError(e, uri);
    }
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    try {
      const core = this.resolveCore(this.machineOf(uri));
      await core.writeFile(uri.path, content, { create: options.create, overwrite: options.overwrite });
      this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    } catch (e) {
      throw toFileSystemError(e, uri);
    }
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    try {
      const core = this.resolveCore(this.machineOf(oldUri));
      await core.rename(oldUri.path, newUri.path, { overwrite: options.overwrite });
      this.emitter.fire([
        { type: vscode.FileChangeType.Deleted, uri: oldUri },
        { type: vscode.FileChangeType.Created, uri: newUri },
      ]);
    } catch (e) {
      throw toFileSystemError(e, newUri);
    }
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    try {
      const core = this.resolveCore(this.machineOf(uri));
      await core.delete(uri.path, { recursive: options.recursive });
      this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    } catch (e) {
      throw toFileSystemError(e, uri);
    }
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    try {
      const core = this.resolveCore(this.machineOf(uri));
      await core.createDirectory(uri.path);
      this.emitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
    } catch (e) {
      throw toFileSystemError(e, uri);
    }
  }
}
