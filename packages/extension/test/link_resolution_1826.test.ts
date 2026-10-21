import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleAmicodeBridgeMessage, type BridgeIo } from "../src/chat_bridge";

// ============================================================================
// #1826 — posture-aware link resolution. Bridge-level fixtures over the
// open-file handler: on the hub-client posture a chat link click re-resolves
// through the hub's resolve-file route and opens in Preview via the hub SDK —
// the client stat routes (vault roots only) but never blocks the open.
// ============================================================================

const window_ = vscode.window as unknown as { messages: string[] };
const commands_ = vscode.commands as unknown as { executed: string[]; executedArgs: unknown[][] };

function io(linkResolution?: Record<string, unknown>): BridgeIo & { posted: unknown[] } {
  const posted: unknown[] = [];
  return {
    posted,
    visible: () => true,
    postToWebview: (m) => {
      posted.push(m);
    },
    ...(linkResolution ? { linkResolution } : {}),
  };
}

/** A hub resolve-file mock that always finds `hubPath`. Records every URL. */
function hubResolveFound(hubPath: string): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ ok: true, found: true, path: hubPath }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch, urls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const hubClientContext = (fetch: typeof fetch) => ({
  posture: "hub-client" as const,
  hubUrl: "http://127.0.0.1:4097",
  fetchImpl: fetch,
});

beforeEach(() => {
  window_.messages.length = 0;
  commands_.executed.length = 0;
  commands_.executedArgs.length = 0;
});

describe("posture-aware link resolution — hub-client (#1826)", () => {
  it("a non-vault path absent locally re-resolves through the hub and posts preview-file (the client stat never blocks)", async () => {
    const { fetch, urls } = hubResolveFound("/home/aaron/.amico/vaults/armonissima/experiments/exp-20261021-x.md");
    const host = io(hubClientContext(fetch));
    // The hub path is NOT on this laptop's disk — the pre-#1826 existsSync
    // gate killed every such click silently.
    const url = "file:///home/aaron/.amico/vaults/armonissima/experiments/exp-20261021-x.md";
    expect(fs.existsSync("/home/aaron/.amico/vaults/armonissima/experiments/exp-20261021-x.md")).toBe(false);
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "open-file", url }, host)).toBe(true);
    await flush();
    // Click-time re-resolution through the hub's resolve-file route happened.
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/amicode/resolve-file?");
    // The hub-resolved path opens in Preview via the hub SDK — no local stat.
    const previewMsg = host.posted.find((m) => (m as { kind?: string }).kind === "preview-file");
    expect(previewMsg).toBeDefined();
    expect((previewMsg as { path: string }).path).toBe(
      "/home/aaron/.amico/vaults/armonissima/experiments/exp-20261021-x.md",
    );
    expect(window_.messages).toHaveLength(0);
  });

  it("a containment miss refuses — no preview, a named not-found-on-hub toast, never a silent no-op", async () => {
    const urls: string[] = [];
    const fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      // The hub's resolve-file answers found:false for a mount-containment
      // miss (the engine's resolver, not the client's disk, decides).
      return new Response(JSON.stringify({ ok: true, found: false }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const host = io(hubClientContext(fetch));
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "open-file", url: "file:///etc/nope-miss.md" }, host)).toBe(true);
    await flush();
    // Refused: nothing opened, and the toast names the failure class.
    expect(host.posted.find((m) => (m as { kind?: string }).kind === "preview-file")).toBeUndefined();
    expect(window_.messages).toHaveLength(1);
    expect(window_.messages[0]).toContain("not-found-on-hub");
  });

  it("the resolve ask carries the ?directory= placement (#1801 lesson) — and keeps the bare ask without one", async () => {
    // Placed: the context directory lands on the ask, URL-encoded, exactly the
    // key the hub frontdoor routes instance requests by.
    const placed = hubResolveFound("/hub/placed.md");
    const hostPlaced = io({ ...hubClientContext(placed.fetch), directory: "/home/aaron/harmoniqs/opencode" });
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "open-file", url: "file:///hub/placed.md" }, hostPlaced)).toBe(true);
    await flush();
    expect(placed.urls[0]).toContain(`directory=${encodeURIComponent("/home/aaron/harmoniqs/opencode")}`);
    // Bare: a missing directory keeps the bare ask (default-engine placement).
    const bare = hubResolveFound("/hub/bare.md");
    const hostBare = io(hubClientContext(bare.fetch));
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "open-file", url: "file:///hub/bare.md" }, hostBare)).toBe(true);
    await flush();
    expect(bare.urls[0]).not.toContain("directory=");
  });
});

// Layer 1 is scoped to vault roots only (#1826, critic round 1's blocking
// fix): the local preference is exactly as wide as the 1:1 sync guarantee —
// a stale local repo checkout must never silently win over the hub's copy.
describe("layer-one scoping — vault roots only (#1826)", () => {
  let savedVaultsRoot: string | undefined;
  let vaultsSandbox: string;

  beforeEach(() => {
    savedVaultsRoot = process.env.AMICO_VAULTS_ROOT;
    vaultsSandbox = fs.mkdtempSync(path.join(os.tmpdir(), "amicode-1826-vaults-"));
    process.env.AMICO_VAULTS_ROOT = vaultsSandbox;
  });

  afterEach(() => {
    if (savedVaultsRoot === undefined) delete process.env.AMICO_VAULTS_ROOT;
    else process.env.AMICO_VAULTS_ROOT = savedVaultsRoot;
    fs.rmSync(vaultsSandbox, { recursive: true, force: true });
  });

  it("a path under a discovered vault mount that exists locally opens local — no hub ask", async () => {
    const mount = path.join(vaultsSandbox, "personal-notebook");
    fs.mkdirSync(mount, { recursive: true });
    fs.writeFileSync(path.join(mount, ".amico-vault.toml"), 'kind = "personal"\nname = "personal-notebook"\n');
    const note = path.join(mount, "experiments", "experiment-20261021-a.md");
    fs.mkdirSync(path.dirname(note), { recursive: true });
    fs.writeFileSync(note, "# local synced copy\n");
    // The hub fetch mock records any ask — layer 1 must make NONE.
    const { fetch, urls } = hubResolveFound("/hub/should-not-be-asked.md");
    const host = io(hubClientContext(fetch));
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "open-file", url: "file://" + note }, host)).toBe(true);
    await flush();
    expect(urls).toHaveLength(0);
    const previewMsg = host.posted.find((m) => (m as { kind?: string }).kind === "preview-file");
    expect(previewMsg).toBeDefined();
    expect((previewMsg as { path: string }).path).toBe(note);
  });

  it("a non-vault path that merely exists locally (a repo checkout) does NOT open local — the hub's resolution wins", async () => {
    // A local checkout the issue warns about: it exists, so the pre-#1826 gate
    // opened it — stale local silently beating the authoritative copy.
    const checkout = path.join(os.tmpdir(), `amicode-1826-checkout-${Date.now()}.md`);
    fs.writeFileSync(checkout, "# stale local checkout\n");
    const { fetch, urls } = hubResolveFound("/home/aaron/harmoniqs/opencode/AGENTS.md");
    const host = io(hubClientContext(fetch));
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "open-file", url: "file://" + checkout }, host)).toBe(true);
    await flush();
    // Re-resolved through the hub at click time — the hub path Previews.
    expect(urls).toHaveLength(1);
    const previewMsg = host.posted.find((m) => (m as { kind?: string }).kind === "preview-file");
    expect(previewMsg).toBeDefined();
    expect((previewMsg as { path: string }).path).toBe("/home/aaron/harmoniqs/opencode/AGENTS.md");
    expect((previewMsg as { path: string }).path).not.toBe(checkout);
    fs.rmSync(checkout, { force: true });
  });
});

// Total failure names why the link died — the Block system's discipline
// (#1826): tunnel-down and not-found-on-hub are distinct, honest classes.
describe("named-outcome toasts on total failure (#1826)", () => {
  it("the hub unreachable (tunnel down) toasts the tunnel-down class — nothing opens", async () => {
    const fetch = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:4097");
    }) as typeof fetch;
    const host = io(hubClientContext(fetch));
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "open-file", url: "file:///hub/anywhere.md" }, host)).toBe(true);
    await flush();
    expect(host.posted.find((m) => (m as { kind?: string }).kind === "preview-file")).toBeUndefined();
    expect(window_.messages).toHaveLength(1);
    expect(window_.messages[0]).toContain("tunnel-down");
  });
});

// Resolver posture awareness (#1826, AC6): the resolution targets the
// session's server per posture — the local posture's panel server IS this
// disk, so it never asks a hub.
describe("resolver posture awareness (#1826)", () => {
  it("the local posture opens an existing non-vault local path and never asks the hub", async () => {
    const local = path.join(os.tmpdir(), `amicode-1826-local-${Date.now()}.md`);
    fs.writeFileSync(local, "# local file\n");
    const { fetch, urls } = hubResolveFound("/hub/never-asked.md");
    const host = io({ posture: "local" as const, hubUrl: "http://127.0.0.1:4097", fetchImpl: fetch });
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "open-file", url: "file://" + local }, host)).toBe(true);
    await flush();
    expect(urls).toHaveLength(0);
    const previewMsg = host.posted.find((m) => (m as { kind?: string }).kind === "preview-file");
    expect(previewMsg).toBeDefined();
    expect((previewMsg as { path: string }).path).toBe(local);
    fs.rmSync(local, { force: true });
  });

  it("the same path on the hub-client posture asks the hub origin instead", async () => {
    const local = path.join(os.tmpdir(), `amicode-1826-hub-${Date.now()}.md`);
    fs.writeFileSync(local, "# local file\n");
    const { fetch, urls } = hubResolveFound("/hub/authoritative.md");
    const host = io(hubClientContext(fetch));
    expect(handleAmicodeBridgeMessage({ source: "amicode", kind: "open-file", url: "file://" + local }, host)).toBe(true);
    await flush();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("http://127.0.0.1:4097/amicode/resolve-file?");
    fs.rmSync(local, { force: true });
  });
});

// The remote affordance (#1826, layer 3): an explicit second action on the
// link posts open-remote-file; the bridge constructs the vscode-remote URI
// with the existing Remote-SSH builder. A missing alias is its own named
// outcome — a fresh non-fleet laptop gets no-ssh-alias, honestly.
describe("the remote affordance — vscode-remote explicit (#1826)", () => {
  it("posts a correctly-formed vscode-remote://ssh-remote+<alias>/<path> URI to vscode.open", async () => {
    const host = io({ posture: "hub-client" as const, sshAlias: "erlich" });
    expect(handleAmicodeBridgeMessage(
      { source: "amicode", kind: "open-remote-file", url: "file:///home/aaron/harmoniqs/opencode/AGENTS.md" },
      host,
    )).toBe(true);
    await flush();
    expect(commands_.executed).toContain("vscode.open");
    const uri = commands_.executedArgs[commands_.executed.indexOf("vscode.open")][0] as { toString(): string };
    expect(uri.toString()).toBe("vscode-remote://ssh-remote+erlich/home/aaron/harmoniqs/opencode/AGENTS.md");
    expect(uri.toString()).toMatch(/^vscode-remote:\/\/ssh-remote\+[^/]+\//);
  });

  it("a missing alias renders the no-ssh-alias named outcome — never a crash", async () => {
    const host = io({ posture: "hub-client" as const });
    expect(handleAmicodeBridgeMessage(
      { source: "amicode", kind: "open-remote-file", url: "file:///home/aaron/notes/x.md" },
      host,
    )).toBe(true);
    await flush();
    expect(commands_.executed).not.toContain("vscode.open");
    expect(window_.messages).toHaveLength(1);
    expect(window_.messages[0]).toContain("no-ssh-alias");
  });
});
