// provider.ts — #1267 the thin vscode.FileSystemProvider adapter over the pure
// host-file core. It holds NO transport or route logic (that all lives in the
// vscode-free HostFileClient): it maps amico-host:// URIs → core calls, core
// results → vscode types, and the typed HostFsError → the matching
// vscode.FileSystemError so VS Code renders the honest outcome. In particular a
// HubDown (unreachable host) surfaces as FileSystemError.Unavailable — the honest
// degraded posture — and there is no local-disk path here to fall back to (AC5).
import * as vscode from "vscode";
import { HostFsError, type HostFs, type HostStat } from "./host_file_client";

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

  constructor(private readonly core: HostFs) {}

  // We do not watch the host filesystem (no host-push channel in this slice);
  // our own mutations fire onDidChangeFile so the Explorer refreshes.
  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    try {
      const st = await this.core.stat(uri.path);
      return { type: toFileType(st.type), ctime: 0, mtime: 0, size: st.size };
    } catch (e) {
      throw toFileSystemError(e, uri);
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    try {
      const entries = await this.core.readDirectory(uri.path);
      return entries.map((e) => [e.name, toFileType(e.type)]);
    } catch (e) {
      throw toFileSystemError(e, uri);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    try {
      return await this.core.readFile(uri.path);
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
      await this.core.writeFile(uri.path, content, { create: options.create, overwrite: options.overwrite });
      this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    } catch (e) {
      throw toFileSystemError(e, uri);
    }
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    try {
      await this.core.rename(oldUri.path, newUri.path, { overwrite: options.overwrite });
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
      await this.core.delete(uri.path, { recursive: options.recursive });
      this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    } catch (e) {
      throw toFileSystemError(e, uri);
    }
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    try {
      await this.core.createDirectory(uri.path);
      this.emitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
    } catch (e) {
      throw toFileSystemError(e, uri);
    }
  }
}
