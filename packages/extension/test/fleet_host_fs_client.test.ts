// fleet_host_fs_client.test.ts — #1267 (fleet client: amico-host:// FileSystemProvider).
//
// The PURE core of the provider: path→route mapping, auth injection, response
// decode, and error translation, tested against the extended stub-hub (Testing
// Decisions: "reuse the stub-hub harness rather than a new fixture"). The core
// imports NO `vscode` and NO `node:fs` — so it can be TDD'd here directly, and
// an unreachable host can NEVER silently degrade into a local-disk read (AC5).
//
// The READ plane (list/read/stat) maps onto the REAL vault-browser contract the
// engine already serves (GET /amicode/vaults + /amicode/vault-files +
// /amicode/vault-file) → those ACs go green against the real engine too. The
// WRITE plane (write/rename/delete/mkdir) maps onto the INTENDED host mutation
// routes the real engine does NOT yet serve (the documented #1267 host-side
// gap): green here against the stub that serves them, and the honest RouteAbsent
// path is pinned against a read-only host that 404s them.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startStubHub, type StubHub, type HostFsSeed } from "./support/stub_hub";
import { HostFileClient, HostFsError } from "../src/fleet_host_fs/host_file_client";

const dec = new TextDecoder();
const enc = new TextEncoder();

const SEED: HostFsSeed = {
  notes: {
    kind: "personal",
    files: {
      "readme.md": "# host readme\n",
      "sub/a.txt": "alpha",
      "sub/b.txt": "bravo",
      "sub/deep/c.txt": "charlie",
    },
  },
  team: { kind: "team", writable: false, files: { "shared.md": "shared" } },
};

/** Build a client whose transport points at a live stub-hub with a fixed mint. */
function clientFor(hub: StubHub, mint = "Bearer host-mint") {
  return new HostFileClient({ baseUrl: () => hub.url, authHeader: () => mint });
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "<no-throw>";
  } catch (e) {
    return e instanceof HostFsError ? e.code : `<${(e as Error)?.name ?? "err"}>`;
  }
}

describe("#1267 host file client — READ plane over the real vault-browser contract", () => {
  let hub: StubHub;
  beforeAll(async () => {
    hub = await startStubHub({ hostFiles: SEED });
  });
  afterAll(async () => {
    await hub.stop();
  });

  it("AC1 — the root lists the host's mounts as directories", async () => {
    const c = clientFor(hub);
    const entries = await c.readDirectory("/");
    const byName = new Map(entries.map((e) => [e.name, e.type]));
    expect(byName.get("notes")).toBe("directory");
    expect(byName.get("team")).toBe("directory");
  });

  it("AC1 — a mount lists its top-level tree (files + subdirs), not the flat recursive list", async () => {
    const c = clientFor(hub);
    const entries = await c.readDirectory("/notes");
    const byName = new Map(entries.map((e) => [e.name, e.type]));
    expect(byName.get("readme.md")).toBe("file");
    expect(byName.get("sub")).toBe("directory");
    // the deep file is NOT surfaced at the mount top — only its ancestor dir is
    expect(byName.has("a.txt")).toBe(false);
    expect(byName.has("deep")).toBe(false);
  });

  it("AC1 — a nested directory lists its immediate children", async () => {
    const c = clientFor(hub);
    const entries = await c.readDirectory("/notes/sub");
    const byName = new Map(entries.map((e) => [e.name, e.type]));
    expect(byName.get("a.txt")).toBe("file");
    expect(byName.get("b.txt")).toBe("file");
    expect(byName.get("deep")).toBe("directory");
  });

  it("AC2 (read) — opening a file returns host content; stat reports a sized file", async () => {
    const c = clientFor(hub);
    const bytes = await c.readFile("/notes/readme.md");
    expect(dec.decode(bytes)).toBe("# host readme\n");
    const st = await c.stat("/notes/readme.md");
    expect(st.type).toBe("file");
    expect(st.size).toBe("# host readme\n".length);
  });

  it("stat reports directories for the root, a mount, and a nested dir", async () => {
    const c = clientFor(hub);
    expect((await c.stat("/")).type).toBe("directory");
    expect((await c.stat("/notes")).type).toBe("directory");
    expect((await c.stat("/notes/sub")).type).toBe("directory");
  });

  it("a missing file is FileNotFound (never a fabricated empty read)", async () => {
    const c = clientFor(hub);
    expect(await codeOf(c.readFile("/notes/missing.md"))).toBe("FileNotFound");
    expect(await codeOf(c.stat("/notes/missing.md"))).toBe("FileNotFound");
  });
});

describe("#1267 host file client — auth injection on every proxied file request", () => {
  let hub: StubHub;
  const MINT = "Bearer host-ops-mint";
  beforeAll(async () => {
    // requireAuth: the stub 401s anything but MINT, so a 200 PROVES injection.
    hub = await startStubHub({ hostFiles: SEED, requireAuth: MINT });
  });
  afterAll(async () => {
    await hub.stop();
  });

  it("the injected Authorization crosses on read/list requests — a 200 proves it", async () => {
    const c = clientFor(hub, MINT);
    const entries = await c.readDirectory("/notes");
    expect(entries.length).toBeGreaterThan(0); // 200, not the 401 the stub gives otherwise
    const fileReqs = hub.requests.filter((r) => r.includes("/amicode/vault-file"));
    expect(fileReqs.length).toBeGreaterThan(0);
    expect(hub.authSeen.every((a) => a === MINT)).toBe(true); // never a missing / wrong header
  });

  it("a client with the WRONG mint is refused (NoPermissions), never silently served", async () => {
    const c = clientFor(hub, "Bearer wrong");
    expect(await codeOf(c.readDirectory("/notes"))).toBe("NoPermissions");
  });
});

describe("#1267 host file client — WRITE plane mutates the host (AC2-write, AC3)", () => {
  let hub: StubHub;
  beforeAll(async () => {
    hub = await startStubHub({ hostFiles: structuredClone(SEED) });
  });
  afterAll(async () => {
    await hub.stop();
  });

  it("AC2 (write) — writing a file lands on the host; an independent re-read reflects it", async () => {
    const c = clientFor(hub);
    await c.writeFile("/notes/created.md", enc.encode("brand new"), { create: true, overwrite: true });
    expect(hub.hostOps.some((o) => o.op === "write" && o.body.path === "created.md")).toBe(true);
    // independent re-read THROUGH the read plane — the write reached the host store
    expect(dec.decode(await c.readFile("/notes/created.md"))).toBe("brand new");
    // overwrite an existing file, re-read reflects the change
    await c.writeFile("/notes/readme.md", enc.encode("changed"), { create: false, overwrite: true });
    expect(dec.decode(await c.readFile("/notes/readme.md"))).toBe("changed");
  });

  it("AC3 — rename moves the file on the host (old gone, new present)", async () => {
    const c = clientFor(hub);
    await c.rename("/notes/sub/b.txt", "/notes/sub/b-renamed.txt", { overwrite: false });
    expect(hub.hostOps.some((o) => o.op === "rename")).toBe(true);
    expect(await codeOf(c.readFile("/notes/sub/b.txt"))).toBe("FileNotFound");
    expect(dec.decode(await c.readFile("/notes/sub/b-renamed.txt"))).toBe("bravo");
  });

  it("AC3 — delete removes the file from the host", async () => {
    const c = clientFor(hub);
    await c.delete("/notes/sub/a.txt", { recursive: false });
    expect(hub.hostOps.some((o) => o.op === "delete" && o.body.path === "sub/a.txt")).toBe(true);
    expect(await codeOf(c.readFile("/notes/sub/a.txt"))).toBe("FileNotFound");
  });

  it("AC3 — createDirectory issues a host mkdir, and a file can then be written into it", async () => {
    const c = clientFor(hub);
    await c.createDirectory("/notes/fresh");
    expect(hub.hostOps.some((o) => o.op === "mkdir" && o.body.path === "fresh")).toBe(true);
    await c.writeFile("/notes/fresh/x.txt", enc.encode("inside"), { create: true, overwrite: true });
    expect(dec.decode(await c.readFile("/notes/fresh/x.txt"))).toBe("inside");
  });

  it("a write to a read-only host mount is NoPermissions (host's own guard), never a fake success", async () => {
    const c = clientFor(hub);
    expect(await codeOf(c.writeFile("/team/shared.md", enc.encode("nope"), { create: false, overwrite: true }))).toBe(
      "NoPermissions",
    );
  });
});

describe("#1267 host file client — the honest host-write-route gap (RouteAbsent)", () => {
  let hub: StubHub;
  beforeAll(async () => {
    // hostReadOnly: the mutation routes 404 exactly as the CURRENT real engine
    // does (no generic host write route yet). The provider must surface this as
    // an explicit RouteAbsent — NOT a fabricated success, NOT a local write.
    hub = await startStubHub({ hostFiles: SEED, hostReadOnly: true });
  });
  afterAll(async () => {
    await hub.stop();
  });

  it("write / rename / delete / mkdir all surface RouteAbsent when the host lacks the route", async () => {
    const c = clientFor(hub);
    expect(await codeOf(c.writeFile("/notes/x.md", enc.encode("x"), { create: true, overwrite: true }))).toBe(
      "RouteAbsent",
    );
    expect(await codeOf(c.rename("/notes/readme.md", "/notes/r.md", {}))).toBe("RouteAbsent");
    expect(await codeOf(c.delete("/notes/readme.md", {}))).toBe("RouteAbsent");
    expect(await codeOf(c.createDirectory("/notes/dir"))).toBe("RouteAbsent");
  });

  it("the READ plane is unaffected by the write gap — reads still work", async () => {
    const c = clientFor(hub);
    expect(dec.decode(await c.readFile("/notes/readme.md"))).toBe("# host readme\n");
  });
});

describe("#1267 host file client — honest hub-down, NEVER a silent local fallback (AC5)", () => {
  it("no bound upstream (tunnel down) → every operation is HubDown, and NO fetch is attempted", async () => {
    let fetchCalls = 0;
    const spyFetch = ((..._a: unknown[]) => {
      fetchCalls++;
      return Promise.reject(new Error("should not be called"));
    }) as unknown as typeof fetch;
    const c = new HostFileClient({ baseUrl: () => undefined, authHeader: () => "Bearer x", fetch: spyFetch });
    expect(await codeOf(c.readDirectory("/notes"))).toBe("HubDown");
    expect(await codeOf(c.stat("/notes/readme.md"))).toBe("HubDown");
    expect(await codeOf(c.readFile("/notes/readme.md"))).toBe("HubDown");
    expect(await codeOf(c.writeFile("/notes/x", enc.encode("x"), {}))).toBe("HubDown");
    expect(fetchCalls).toBe(0); // no upstream → it does not even try; it certainly never reads local disk
  });

  it("a transport failure (connection refused / thrown fetch) is HubDown, not an error dump", async () => {
    const throwing = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    const c = new HostFileClient({ baseUrl: () => "http://127.0.0.1:1", authHeader: () => "Bearer x", fetch: throwing });
    expect(await codeOf(c.readDirectory("/notes"))).toBe("HubDown");
    expect(await codeOf(c.readFile("/notes/readme.md"))).toBe("HubDown");
  });

  it("a relay hub-down 503 is HubDown (honest degraded posture, not a fabricated read)", async () => {
    const fake503 = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: false, error: "fleet-hub-down", pointer: "x" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      )) as unknown as typeof fetch;
    const c = new HostFileClient({ baseUrl: () => "http://127.0.0.1:2", authHeader: () => "Bearer x", fetch: fake503 });
    expect(await codeOf(c.readFile("/notes/readme.md"))).toBe("HubDown");
  });
});
