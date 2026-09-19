// fleet_host_fs_provider.test.ts — #1267 the thin vscode.FileSystemProvider
// adapter over the pure core. Pins two things: (1) HostFsError → the correct
// vscode.FileSystemError code (so VS Code renders the honest outcome — FileNotFound,
// Unavailable for hub-down, etc. — and NEVER a silent local read); (2) end-to-end
// through the real core against the stub-hub: open shows host content and save
// writes back (AC2 at the provider layer). The `vscode` module is the aliased mock.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startStubHub, type StubHub, type HostFsSeed } from "./support/stub_hub";
import { HostFileClient, HostFsError, type HostFs } from "../src/fleet_host_fs/host_file_client";
import { AmicoHostFileSystemProvider } from "../src/fleet_host_fs/provider";
import * as vscode from "vscode";

const dec = new TextDecoder();
const enc = new TextEncoder();
const uri = (p: string) => ({ scheme: "amico-host", path: p, toString: () => `amico-host:${p}` }) as unknown as vscode.Uri;

async function fsErrCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "<no-throw>";
  } catch (e) {
    return (e as { code?: string })?.code ?? `<${(e as Error)?.name}>`;
  }
}

/** A fake core that throws a chosen HostFsError from every method. */
function throwingCore(code: ConstructorParameters<typeof HostFsError>[0]): HostFs {
  const boom = () => Promise.reject(new HostFsError(code, `forced ${code}`));
  return {
    readDirectory: boom,
    stat: boom,
    readFile: boom,
    writeFile: boom,
    rename: boom,
    delete: boom,
    createDirectory: boom,
  };
}

describe("#1267 provider adapter — HostFsError → vscode.FileSystemError mapping", () => {
  it("FileNotFound → FileNotFound", async () => {
    const p = new AmicoHostFileSystemProvider(throwingCore("FileNotFound"));
    expect(await fsErrCode(p.stat(uri("/notes/x")))).toBe("FileNotFound");
    expect(await fsErrCode(p.readFile(uri("/notes/x")))).toBe("FileNotFound");
  });

  it("HubDown → Unavailable (the honest degraded posture — VS Code shows it, no local fallback) (AC5)", async () => {
    const p = new AmicoHostFileSystemProvider(throwingCore("HubDown"));
    expect(await fsErrCode(p.stat(uri("/notes/x")))).toBe("Unavailable");
    expect(await fsErrCode(p.readDirectory(uri("/notes")))).toBe("Unavailable");
    expect(await fsErrCode(p.readFile(uri("/notes/x")))).toBe("Unavailable");
  });

  it("RouteAbsent (the host write-route gap) → an explicit error, never a silent success", async () => {
    const p = new AmicoHostFileSystemProvider(throwingCore("RouteAbsent"));
    const code = await fsErrCode(p.writeFile(uri("/notes/x"), enc.encode("y"), { create: true, overwrite: true }));
    expect(["NoPermissions", "Unavailable"]).toContain(code); // a real FileSystemError, not resolve()
  });

  it("NoPermissions → NoPermissions; FileExists → FileExists", async () => {
    expect(await fsErrCode(new AmicoHostFileSystemProvider(throwingCore("NoPermissions")).readFile(uri("/t/x")))).toBe(
      "NoPermissions",
    );
    expect(
      await fsErrCode(
        new AmicoHostFileSystemProvider(throwingCore("FileExists")).rename(uri("/n/a"), uri("/n/b"), { overwrite: false }),
      ),
    ).toBe("FileExists");
  });
});

describe("#1267 provider adapter — end-to-end over the stub-hub (AC1/AC2/AC3)", () => {
  let hub: StubHub;
  let provider: AmicoHostFileSystemProvider;
  const SEED: HostFsSeed = { notes: { kind: "personal", files: { "readme.md": "host body\n", "sub/a.txt": "alpha" } } };
  beforeAll(async () => {
    hub = await startStubHub({ hostFiles: structuredClone(SEED) });
    provider = new AmicoHostFileSystemProvider(new HostFileClient({ baseUrl: () => hub.url, authHeader: () => "Bearer m" }));
  });
  afterAll(async () => {
    await hub.stop();
  });

  it("AC1 — readDirectory maps host entries to [name, FileType]", async () => {
    const entries = await provider.readDirectory(uri("/notes"));
    const byName = new Map(entries.map(([n, t]) => [n, t]));
    expect(byName.get("readme.md")).toBe(vscode.FileType.File);
    expect(byName.get("sub")).toBe(vscode.FileType.Directory);
  });

  it("AC2 — open shows host content; save writes back; an independent re-read reflects it", async () => {
    expect(dec.decode(await provider.readFile(uri("/notes/readme.md")))).toBe("host body\n");
    await provider.writeFile(uri("/notes/readme.md"), enc.encode("edited on host"), { create: false, overwrite: true });
    expect(dec.decode(await provider.readFile(uri("/notes/readme.md")))).toBe("edited on host");
    expect(hub.hostOps.some((o) => o.op === "write" && o.body.path === "readme.md")).toBe(true);
  });

  it("stat maps to a vscode FileStat (type + size)", async () => {
    const st = await provider.stat(uri("/notes/sub/a.txt"));
    expect(st.type).toBe(vscode.FileType.File);
    expect(st.size).toBe("alpha".length);
  });
});
