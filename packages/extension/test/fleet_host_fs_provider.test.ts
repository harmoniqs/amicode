// fleet_host_fs_provider.test.ts — #1267 the thin vscode.FileSystemProvider
// adapter over the pure core. Pins two things: (1) HostFsError → the correct
// vscode.FileSystemError code (so VS Code renders the honest outcome — FileNotFound,
// Unavailable for hub-down, etc. — and NEVER a silent local read); (2) end-to-end
// through the real core against the stub-hub: open shows host content and save
// writes back (AC2 at the provider layer). The `vscode` module is the aliased mock.
//
// #1441: extended for machine-scoped workspace browsing — the URI authority becomes
// the machine, per-machine transport resolution, write → read-only via RouteAbsent
// (NOT the write-capable stub), and unreachable → HubDown/Unavailable.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startStubHub, type StubHub, type HostFsSeed } from "./support/stub_hub";
import { HostFileClient, HostFsError, type HostFs } from "../src/fleet_host_fs/host_file_client";
import { AmicoHostFileSystemProvider } from "../src/fleet_host_fs/provider";
import type { HostFsResolver } from "../src/fleet_host_fs/provider";
import * as vscode from "vscode";

const dec = new TextDecoder();
const enc = new TextEncoder();
/** URI without authority (the existing pre-#1441 shape). */
const uri = (p: string) => ({ scheme: "amico-host", authority: "", path: p, toString: () => `amico-host:${p}` }) as unknown as vscode.Uri;
/** URI WITH authority — the #1441 machine-scoped shape. */
const machineUri = (machine: string, p: string) => ({
  scheme: "amico-host",
  authority: machine,
  path: p,
  toString: () => `amico-host://${machine}${p}`,
}) as unknown as vscode.Uri;

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

// ── #1441 AC5: workspace browser — amico-host://<machine> ────────────────────

describe("#1441 workspace browser — URI authority becomes machine (AC5)", () => {
  it("provider passes URI authority as the machine to the core resolver", async () => {
    let resolvedMachine: string | undefined = "UNSET";
    const mockCore: HostFs = {
      stat: async () => ({ type: "file" as const, size: 42 }),
      readDirectory: async () => [],
      readFile: async () => new Uint8Array(),
      writeFile: async () => {},
      rename: async () => {},
      delete: async () => {},
      createDirectory: async () => {},
    };
    const resolver: HostFsResolver = (machine?: string) => {
      resolvedMachine = machine;
      return mockCore;
    };
    const provider = new AmicoHostFileSystemProvider(resolver);

    // stat with a machine-scoped URI — authority must reach the resolver
    await provider.stat(machineUri("mac-studio-01", "/workspace/src/main.jl"));
    expect(resolvedMachine).toBe("mac-studio-01");
  });

  it("provider passes EMPTY authority as undefined for local URIs", async () => {
    let resolvedMachine: string | undefined = "UNSET";
    const mockCore: HostFs = {
      stat: async () => ({ type: "file" as const, size: 0 }),
      readDirectory: async () => [],
      readFile: async () => new Uint8Array(),
      writeFile: async () => {},
      rename: async () => {},
      delete: async () => {},
      createDirectory: async () => {},
    };
    const resolver: HostFsResolver = (machine?: string) => {
      resolvedMachine = machine;
      return mockCore;
    };
    const provider = new AmicoHostFileSystemProvider(resolver);

    // stat with a local URI (empty authority) — resolver receives undefined
    await provider.stat(uri("/notes/readme.md"));
    expect(resolvedMachine).toBeUndefined();
  });

  it("readDirectory + readFile route through the machine-resolved core", async () => {
    const resolver: HostFsResolver = (machine?: string) => {
      if (machine === "remote-box") {
        return {
          stat: async () => ({ type: "directory" as const, size: 0 }),
          readDirectory: async () => [{ name: "remote.txt", type: "file" as const, size: 10 }],
          readFile: async () => enc.encode("remote content"),
          writeFile: async () => {},
          rename: async () => {},
          delete: async () => {},
          createDirectory: async () => {},
        };
      }
      return throwingCore("FileNotFound"); // local has nothing
    };
    const provider = new AmicoHostFileSystemProvider(resolver);

    // Reading from the remote machine succeeds
    const entries = await provider.readDirectory(machineUri("remote-box", "/workspace"));
    expect(entries).toHaveLength(1);
    expect(entries[0][0]).toBe("remote.txt");

    const content = dec.decode(await provider.readFile(machineUri("remote-box", "/workspace/remote.txt")));
    expect(content).toBe("remote content");

    // Reading from local (no authority) fails — different core
    expect(await fsErrCode(provider.readFile(uri("/workspace/remote.txt")))).toBe("FileNotFound");
  });
});

describe("#1441 workspace browser — per-machine transport via stub-hubs (AC5)", () => {
  let hubA: StubHub;
  let hubB: StubHub;

  beforeAll(async () => {
    hubA = await startStubHub({
      hostFiles: { workspace: { kind: "personal", files: { "src/main.jl": "# machine A" } } },
    });
    hubB = await startStubHub({
      hostFiles: { workspace: { kind: "personal", files: { "src/main.jl": "# machine B" } } },
    });
  });
  afterAll(async () => {
    await Promise.all([hubA.stop(), hubB.stop()]);
  });

  it("per-machine transport resolves different baseUrls to different hosts", async () => {
    const resolver: HostFsResolver = (machine?: string) => {
      if (machine === "machine-a") {
        return new HostFileClient({ baseUrl: () => hubA.url, authHeader: () => "Bearer m" });
      }
      if (machine === "machine-b") {
        return new HostFileClient({ baseUrl: () => hubB.url, authHeader: () => "Bearer m" });
      }
      return throwingCore("HubDown");
    };
    const provider = new AmicoHostFileSystemProvider(resolver);

    const contentA = dec.decode(await provider.readFile(machineUri("machine-a", "/workspace/src/main.jl")));
    expect(contentA).toBe("# machine A");

    const contentB = dec.decode(await provider.readFile(machineUri("machine-b", "/workspace/src/main.jl")));
    expect(contentB).toBe("# machine B");
  });
});

describe("#1441 workspace browser — honest failure modes (AC5)", () => {
  it("write attempt against RouteAbsent seam → honest read-only (throwingCore, NOT write-capable stub)", async () => {
    // The issue is explicit: use throwingCore("RouteAbsent"), NOT the write-capable
    // stub from the existing AC2 test. This asserts the read-only honesty of the
    // workspace browser — writes are not implemented.
    const provider = new AmicoHostFileSystemProvider(
      () => throwingCore("RouteAbsent"),
    );
    const code = await fsErrCode(
      provider.writeFile(machineUri("remote-box", "/workspace/src/new.jl"), enc.encode("data"), { create: true, overwrite: true }),
    );
    expect(["NoPermissions", "Unavailable"]).toContain(code);
    // Also assert rename and delete are equally blocked
    expect(["NoPermissions", "Unavailable"]).toContain(
      await fsErrCode(provider.rename(machineUri("remote-box", "/a"), machineUri("remote-box", "/b"), { overwrite: false })),
    );
    expect(["NoPermissions", "Unavailable"]).toContain(
      await fsErrCode(provider.delete(machineUri("remote-box", "/a"), { recursive: false })),
    );
  });

  it("unreachable machine → honest HubDown/Unavailable, no local read", async () => {
    const provider = new AmicoHostFileSystemProvider(
      () => throwingCore("HubDown"),
    );
    expect(await fsErrCode(provider.stat(machineUri("down-box", "/workspace/src/main.jl")))).toBe("Unavailable");
    expect(await fsErrCode(provider.readDirectory(machineUri("down-box", "/workspace")))).toBe("Unavailable");
    expect(await fsErrCode(provider.readFile(machineUri("down-box", "/workspace/src/main.jl")))).toBe("Unavailable");
  });

  it("machine-scoped read-only stub-hub → write returns RouteAbsent/NoPermissions", async () => {
    // End-to-end: a read-only stub-hub (hostReadOnly: true) returns 404 on
    // write routes, which the client surfaces as RouteAbsent.
    const hub = await startStubHub({
      hostFiles: { workspace: { kind: "personal", files: { "readme.md": "read me" } } },
      hostReadOnly: true,
    });
    try {
      const provider = new AmicoHostFileSystemProvider(
        () => new HostFileClient({ baseUrl: () => hub.url, authHeader: () => "Bearer m" }),
      );
      // Read succeeds
      const content = dec.decode(await provider.readFile(machineUri("remote", "/workspace/readme.md")));
      expect(content).toBe("read me");
      // Write fails honestly
      const code = await fsErrCode(
        provider.writeFile(machineUri("remote", "/workspace/new.txt"), enc.encode("x"), { create: true, overwrite: true }),
      );
      expect(["NoPermissions", "Unavailable"]).toContain(code);
    } finally {
      await hub.stop();
    }
  });
});
