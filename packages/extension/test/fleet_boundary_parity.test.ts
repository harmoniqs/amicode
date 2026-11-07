// fleet_boundary_parity.test.ts — #1485 (ADR 0034, Binding Amendment 1):
// PRODUCTION BOUNDARY PARITY + HEADLESS PEER BOOT.
//
// The completion slice that #1478 explicitly deferred here. Two things are
// proven:
//
//   AC1 — direct-engine, proxied-engine, SSE, and upgrade requests produce
//         IDENTICAL allow/deny for every shared membership credential state.
//         The service boundary (server.ts authorized()) and the engine
//         boundary (overlay auth.ts authorized()/required()) enforce ONE
//         membership decision — the accept-set — over the SAME on-disk stores.
//         The load-bearing test is a SHARED CREDENTIAL MATRIX: every credential
//         state × {direct-engine, proxied-engine, SSE, upgrade} → one verdict.
//
//   AC2 — service-only bootstrap routes (the #1471 peer-token mint/revoke
//         endpoints) are EXCLUDED from the parity matrix: they accept ONLY
//         their bound bootstrap principal (a valid enrollment nonce on the
//         mint path), never a membership credential, and a membership
//         credential never mints.
//
//   AC3 — a headless independent peer (no editor host present) boots the base
//         observation infrastructure (/amicode/fleet/status + sessions) and
//         records a NAMED posture — reusing the #1478 base-activation authority.
//
//   AC4 — hub/client compatibility is unchanged (the #1263 client-relay upgrade
//         tunnel and the fleet-of-one no-op both still hold).
//
// INVARIANT (this slice): no lifecycle scope claim is enforced here, and no
// privileged credential is forwarded to a peer.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as net from "node:net";
import { randomBytes } from "node:crypto";

import { AmicodeServiceServer } from "../src/amicode_service/server";
import { serverAuthHeader } from "../src/server_auth";
import { hubUpstreamAuthHeader } from "../src/amicode_service/hub_credential";
import {
  buildAcceptSet,
  closeAcceptSet,
} from "../src/amicode_service/fleet_accept_set";
import {
  peerTokenMintHandler,
  peerRevokeHandler,
  MINT_ENDPOINT_PATH,
  PEER_REVOKE_PATH,
} from "../src/amicode_service/fleet_mint_route";
import { mintPeerToken, revokePeerToken } from "../src/amicode_service/fleet_issued_tokens";
import { mintEnrollmentNonce } from "../src/amicode_service/fleet_enrollment_nonce";

function tmproot(): string {
  return mkdtempSync(join(tmpdir(), "amicode-1485-parity-"));
}

// ── the raw-socket upgrade probe (a WS handshake, read the status line) ──────
// Reused idiom from fleet_ws_upgrade.test.ts: send a GET Upgrade request, read
// the first response line. The service either 101/proceeds (allowed) or emits a
// 401 on the raw socket (denied). A dropped socket with no status line is a
// denial too (the no-listener fall-through).
interface UpgradeProbe {
  statusCode: number | null; // null = socket closed before any status line
}
function upgradeProbe(
  origin: string,
  path: string,
  extraHeaders: Record<string, string> = {},
): Promise<UpgradeProbe> {
  const u = new URL(origin);
  const key = randomBytes(16).toString("base64");
  return new Promise<UpgradeProbe>((resolve) => {
    let settled = false;
    const done = (statusCode: number | null) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve({ statusCode });
    };
    const socket = net.connect(Number(u.port), u.hostname, () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${u.host}`,
        `Upgrade: websocket`,
        `Connection: Upgrade`,
        `Sec-WebSocket-Key: ${key}`,
        `Sec-WebSocket-Version: 13`,
        ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`),
        ``,
        ``,
      ];
      socket.write(lines.join("\r\n"));
    });
    let hdr = Buffer.alloc(0);
    socket.on("data", (d: Buffer) => {
      hdr = Buffer.concat([hdr, d]);
      const idx = hdr.indexOf("\r\n");
      if (idx === -1) return;
      const statusLine = hdr.subarray(0, idx).toString("utf8");
      done(Number(statusLine.split(" ")[1]));
    });
    socket.on("error", () => done(null));
    socket.on("close", () => done(null));
    setTimeout(() => done(null), 1500);
  });
}

const peerHeader = (token: string) => ({ Authorization: serverAuthHeader(token) });

// ── a base-studio-shaped service: accept-set armed, engine-armed, NON-client,
//    no attached upstream (an independent serving peer observing its own). This
//    is the posture whose upgrade path AC1 must membership-gate. ──────────────
interface Booted {
  origin: string;
  server: AmicodeServiceServer;
  files: { issued: string; phase: string; nonce: string };
  hubToken: string;
  stop: () => Promise<void>;
}

async function bootBaseStudio(opts: { authMode?: "open" | "credential" } = {}): Promise<Booted> {
  const root = tmproot();
  const files = {
    issued: join(root, "fleet-peer-tokens.json"),
    phase: join(root, "fleet-accept-set.json"),
    nonce: join(root, "fleet-enrollment-nonces.json"),
  };
  const hubToken = "hub-transitional-token";
  const acceptSet = buildAcceptSet({
    issuedRegistryFile: files.issued,
    phaseStateFile: files.phase,
    enrollmentNonceFile: files.nonce,
    hubCredentialToken: () => hubToken,
  });
  const server = new AmicodeServiceServer({
    password: "service-own-mint",
    authMode: opts.authMode ?? "open",
    acceptSet,
  });
  server.add("GET", "/amicode/ping", () => ({ body: JSON.stringify({ ok: true }) }));
  // an SSE-shaped route (a GET the accept-set gates exactly as any read)
  server.add("GET", "/amicode/stream", () => ({
    body: "data: hello\n\n",
    contentType: "text/event-stream",
  }));
  server.add(
    "POST",
    MINT_ENDPOINT_PATH,
    peerTokenMintHandler({ issuedRegistryFile: files.issued, enrollmentNonceFile: files.nonce }),
  );
  server.add("POST", PEER_REVOKE_PATH, peerRevokeHandler({ issuedRegistryFile: files.issued }));
  const origin = (await server.start()).toString().replace(/\/$/, "");
  return { origin, server, files, hubToken, stop: () => server.stop() };
}

// ═══════════════════════════════════════════════════════════════════════════
// AC1 — the upgrade path shares the membership decision (the deferred gap)
// ═══════════════════════════════════════════════════════════════════════════
describe("AC1 — the upgrade path enforces the accept-set membership decision (parity with request auth)", () => {
  let b: Booted;
  beforeEach(async () => {
    b = await bootBaseStudio();
    mintPeerToken("peer-a", { registryFile: b.files.issued, tokenFactory: () => "PEER-A-TOK-000000000000" });
    closeAcceptSet({ phaseStateFile: b.files.phase });
  });
  afterEach(() => b?.stop());

  it("a NON-member upgrade is refused (401) exactly as a non-member request is — no tunnel before the membership check", async () => {
    // a regular request with no credential 401s on the closed accept-set
    const req = await fetch(`${b.origin}/amicode/ping`);
    expect(req.status).toBe(401);
    // the upgrade with the same (absent) credential must ALSO be refused — the
    // membership decision is shared, so an anonymous upgrade cannot slip past
    const up = await upgradeProbe(`${b.origin}/pty/term-1/connect`, "/pty/term-1/connect");
    expect(up.statusCode).toBe(401);
  });

  it("a MEMBER upgrade is NOT refused with 401 — the accept-set admits it exactly as it admits a request", async () => {
    const req = await fetch(`${b.origin}/amicode/ping`, { headers: peerHeader("PEER-A-TOK-000000000000") });
    expect(req.status).toBe(200);
    // the same member credential on an upgrade is NOT 401'd by the boundary (it
    // proceeds to routing, which — no attached upstream here — closes the socket
    // with no status line; the observable is simply "not a 401 membership deny")
    const up = await upgradeProbe(`${b.origin}/pty/term-1/connect`, "/pty/term-1/connect", {
      Authorization: serverAuthHeader("PEER-A-TOK-000000000000"),
    });
    expect(up.statusCode).not.toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC1 — THE SHARED CREDENTIAL MATRIX (the load-bearing parity proof)
//
// Every shared membership credential state × {proxied-engine, SSE, upgrade}
// must produce ONE allow/deny verdict at the service boundary — the single
// decision every non-direct surface routes through (authorized() runs BEFORE
// dispatch for requests and BEFORE any tunnel for upgrades). The `expectAllow`
// column is the accept-set's verdict for that credential state (a CLOSED
// boundary: members allowed, everyone else denied); the matrix asserts each
// surface returns exactly that verdict — no surface may diverge.
// ═══════════════════════════════════════════════════════════════════════════
describe("AC1 — shared credential matrix: proxied-engine, SSE, and upgrade agree per credential state (CLOSED boundary)", () => {
  let b: Booted;
  beforeEach(async () => {
    b = await bootBaseStudio();
    mintPeerToken("peer-a", { registryFile: b.files.issued, tokenFactory: () => "MEMBER-PEER-TOKEN-0001" });
    revokePeerToken("revoked-peer", { registryFile: b.files.issued }); // establishes a bar; no live token
    closeAcceptSet({ phaseStateFile: b.files.phase });
  });
  afterEach(() => b?.stop());

  // Every shared membership credential state, and the accept-set's verdict for
  // it on a CLOSED boundary. (The mint/nonce bootstrap principal is AC2's
  // territory — deliberately NOT a row here.)
  const matrix: Array<{ state: string; header?: Record<string, string>; expectAllow: boolean }> = [
    { state: "anonymous (no credential)", expectAllow: false },
    { state: "local service mint (accept-set member)", header: peerHeader("service-own-mint"), expectAllow: true },
    { state: "non-revoked issued peer token (member)", header: peerHeader("MEMBER-PEER-TOKEN-0001"), expectAllow: true },
    { state: "wrong-length garbage token", header: peerHeader("nope"), expectAllow: false },
    {
      state: "equal-length wrong token",
      header: peerHeader("XXXXXXXXXXXXXXXXXXXXXX"),
      expectAllow: false,
    },
    {
      state: "transitional hub credential (withdrawn at close)",
      header: { Authorization: "" }, // filled per-test below with the hub header
      expectAllow: false,
    },
  ];

  for (const row of matrix) {
    it(`credential state "${row.state}" → proxied-engine, SSE, upgrade all ${row.expectAllow ? "ALLOW" : "DENY"} identically`, async () => {
      // the hub-credential row uses the real hub header (verifies it is DENIED
      // after close, alongside the others)
      const header =
        row.state.startsWith("transitional hub")
          ? { Authorization: hubUpstreamAuthHeader(b.hubToken) }
          : row.header;

      // proxied-engine: a non-/amicode path routes to the engine proxy AFTER
      // the membership gate. deny → 401 at the boundary; allow → past the gate
      // (no engine bound here → the honest 503, which is NOT a membership deny).
      const proxied = await fetch(`${b.origin}/session`, header ? { headers: header } : {});
      const proxiedAllow = proxied.status !== 401;

      // SSE: a GET event-stream route, gated by the same authorized().
      const sse = await fetch(`${b.origin}/amicode/stream`, header ? { headers: header } : {});
      const sseAllow = sse.status !== 401;

      // upgrade: the WS handshake path, now membership-gated (AC1 tracer).
      const up = await upgradeProbe(`${b.origin}/pty/x/connect`, "/pty/x/connect", header ?? {});
      const upgradeAllow = up.statusCode !== 401;

      // the parity assertion: all three surfaces return the SAME verdict…
      expect({ proxiedAllow, sseAllow, upgradeAllow }).toEqual({
        proxiedAllow: row.expectAllow,
        sseAllow: row.expectAllow,
        upgradeAllow: row.expectAllow,
      });
    });
  }

  it("the three non-direct surfaces never diverge on ANY row (the matrix is internally consistent)", async () => {
    // an explicit cross-surface consistency sweep: for each row, the three
    // booleans are equal to each other (a divergence would be an AC1 breach even
    // if it happened to match expectAllow on one surface by accident).
    for (const row of matrix) {
      const header =
        row.state.startsWith("transitional hub")
          ? { Authorization: hubUpstreamAuthHeader(b.hubToken) }
          : row.header;
      const proxied = (await fetch(`${b.origin}/session`, header ? { headers: header } : {})).status !== 401;
      const sse = (await fetch(`${b.origin}/amicode/stream`, header ? { headers: header } : {})).status !== 401;
      const up = (await upgradeProbe(`${b.origin}/pty/x/connect`, "/pty/x/connect", header ?? {})).statusCode !== 401;
      expect(proxied).toBe(sse);
      expect(sse).toBe(up);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC1 — DIRECT-ENGINE parity: the engine boundary's verdict equals the service
// boundary's, per credential state, over the SAME on-disk accept-set stores.
//
// The engine overlay (overlay/.../server/auth.ts) is a bun/effect module the
// extension suite cannot import; its OWN suite (auth-accept-set.test.ts) proves
// its per-state behavior directly. Here we prove the CROSS-boundary claim
// mechanically: the engine boundary's decision algorithm — closed⇒require, then
// (local password ∨ non-revoked issued token) — computed over the SAME files the
// service reads yields the SAME allow/deny the service HTTP boundary returns.
// One decision, two boundaries, identical verdicts.
// ═══════════════════════════════════════════════════════════════════════════
import { readIssuedTokens } from "../src/amicode_service/fleet_issued_tokens";
import { acceptSetPhase } from "../src/amicode_service/fleet_accept_set";

/** The engine boundary's verdict, computed from the SHARED stores by the
 *  overlay's documented algorithm (auth.ts): a caller is allowed iff the
 *  boundary is not armed, OR it presents the local password, OR it presents a
 *  non-revoked issued peer token. The engine has NO hub-credential clause and
 *  NO nonce clause — those are service-only (the hub credential is the service's
 *  transitional additive member; the nonce is the mint bootstrap) — so a hub
 *  credential is DENIED at the engine exactly as it is at the closed service
 *  boundary. Reads the same files the overlay reads (issued registry + phase). */
function engineBoundaryAllows(
  presented: string | undefined,
  files: { issued: string; phase: string },
  localPassword: string,
): boolean {
  const armed =
    localPassword !== "" || acceptSetPhase({ phaseStateFile: files.phase }) === "closed";
  if (!armed) return true; // unarmed engine behind the tunnel accepts anonymous
  if (presented === undefined) return false;
  if (presented === localPassword) return true;
  return readIssuedTokens({ registryFile: files.issued }).includes(presented);
}

/** Extract the raw secret a Basic `opencode:<secret>` header carries (what the
 *  engine's DecodedCredentials.password would hold), or undefined for none. */
function presentedSecret(header: Record<string, string> | undefined): string | undefined {
  const auth = header?.Authorization;
  if (!auth || !auth.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(auth.slice(6).trim(), "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon === -1 ? undefined : decoded.slice(colon + 1);
}

describe("AC1 — direct-engine parity: the engine boundary's verdict equals the service boundary's per credential state", () => {
  let b: Booted;
  beforeEach(async () => {
    b = await bootBaseStudio();
    mintPeerToken("peer-a", { registryFile: b.files.issued, tokenFactory: () => "MEMBER-PEER-TOKEN-0001" });
    closeAcceptSet({ phaseStateFile: b.files.phase });
  });
  afterEach(() => b?.stop());

  const rows: Array<{ state: string; header?: Record<string, string> }> = [
    { state: "anonymous" },
    { state: "local mint (member)", header: peerHeader("service-own-mint") },
    { state: "issued peer token (member)", header: peerHeader("MEMBER-PEER-TOKEN-0001") },
    { state: "garbage token", header: peerHeader("nope") },
  ];

  for (const row of rows) {
    it(`"${row.state}": the engine boundary and the service boundary agree`, async () => {
      // service boundary (proxied-engine surface) HTTP verdict
      const serviceAllow = (await fetch(`${b.origin}/session`, row.header ? { headers: row.header } : {})).status !== 401;
      // engine boundary verdict over the SAME stores
      const engineAllow = engineBoundaryAllows(presentedSecret(row.header), b.files, "service-own-mint");
      expect(engineAllow).toBe(serviceAllow);
    });
  }

  it("the transitional hub credential is DENIED at BOTH boundaries after close (no engine hub-credential clause)", async () => {
    const header = { Authorization: hubUpstreamAuthHeader(b.hubToken) };
    const serviceAllow = (await fetch(`${b.origin}/session`, { headers: header })).status !== 401;
    const engineAllow = engineBoundaryAllows(presentedSecret(header), b.files, "service-own-mint");
    expect(serviceAllow).toBe(false);
    expect(engineAllow).toBe(false);
    expect(engineAllow).toBe(serviceAllow);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC2 — the service-only bootstrap routes are EXCLUDED from the parity matrix
//
// The #1471 peer-token mint endpoint is NOT membership-authorized like session
// traffic: a joining machine holds NO membership credential, so the mint path
// is the ONE bearer-less path (its bound bootstrap principal is a valid, single-
// use enrollment nonce, §D4). It must therefore be governed DIFFERENTLY from the
// parity matrix — a membership credential does not, by itself, mint a token, and
// the bootstrap principal (the nonce) is not a member of the session accept-set.
// ═══════════════════════════════════════════════════════════════════════════
import { issuedTokenFor } from "../src/amicode_service/fleet_issued_tokens";

describe("AC2 — the mint bootstrap route accepts ONLY its bound bootstrap principal (excluded from the membership matrix)", () => {
  let b: Booted;
  beforeEach(async () => {
    b = await bootBaseStudio();
    closeAcceptSet({ phaseStateFile: b.files.phase });
  });
  afterEach(() => b?.stop());

  it("a valid enrollment nonce mints — even though it is NOT a member of the session accept-set", async () => {
    // the nonce is NOT a membership credential — a request to a session route
    // bearing nothing 401s (proven above). Yet on the bootstrap route it mints.
    const nonce = mintEnrollmentNonce({ storeFile: b.files.nonce, nonceFactory: () => "BOOT-NONCE-1", ttlMs: 60_000 });
    const res = await fetch(`${b.origin}${MINT_ENDPOINT_PATH}?machine_id=joiner&enrollment_nonce=${nonce}`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; token: string };
    expect(body.ok).toBe(true);
    expect(issuedTokenFor("joiner", { registryFile: b.files.issued })).toBe(body.token);
  });

  it("a MEMBERSHIP credential does NOT mint on the bootstrap route (the bound principal is the nonce, not membership)", async () => {
    // seed a member, then present it on the mint path WITHOUT a nonce — the
    // route refuses to mint (401), because the bound bootstrap principal is the
    // nonce, not a membership credential. The mint route is not membership-
    // authorized like session traffic (AC2's exclusion).
    mintPeerToken("member-x", { registryFile: b.files.issued, tokenFactory: () => "MEMBER-X-TOKEN-00000001" });
    const res = await fetch(`${b.origin}${MINT_ENDPOINT_PATH}?machine_id=usurper`, {
      method: "POST",
      headers: peerHeader("MEMBER-X-TOKEN-00000001"),
    });
    // no valid nonce presented → the bootstrap principal is absent → refused,
    // and CRUCIALLY no token was minted for the usurper machine_id.
    expect(res.status).toBe(401);
    expect(issuedTokenFor("usurper", { registryFile: b.files.issued })).toBeUndefined();
  });

  it("an INVALID enrollment nonce is refused (the bound principal must be valid, not merely present)", async () => {
    const res = await fetch(`${b.origin}${MINT_ENDPOINT_PATH}?machine_id=joiner&enrollment_nonce=never-minted`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
    expect(issuedTokenFor("joiner", { registryFile: b.files.issued })).toBeUndefined();
  });

  it("the mint path is NOT in the membership matrix: a member session credential is admitted on session routes but does not confer mint authority", async () => {
    mintPeerToken("member-y", { registryFile: b.files.issued, tokenFactory: () => "MEMBER-Y-TOKEN-00000001" });
    // admitted on a session (proxied-engine) route — it IS a member there
    const session = await fetch(`${b.origin}/session`, { headers: peerHeader("MEMBER-Y-TOKEN-00000001") });
    expect(session.status).not.toBe(401);
    // but the SAME credential does not mint on the bootstrap route (no nonce)
    const mint = await fetch(`${b.origin}${MINT_ENDPOINT_PATH}?machine_id=member-y-clone`, {
      method: "POST",
      headers: peerHeader("MEMBER-Y-TOKEN-00000001"),
    });
    expect(mint.status).toBe(401);
    expect(issuedTokenFor("member-y-clone", { registryFile: b.files.issued })).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC3 — a HEADLESS independent peer boots base observation infra + records a
//       NAMED posture (reusing the #1478 base-activation authority)
//
// "Headless" means no editor host present — createAmicodeService is vscode-free
// by construction (it boots in-process here with no VS Code host), so a
// successful boot IS the headless boot. The base-activation authority
// (baseStudioActivates: a non-client with ≥1 verified serving peer) mounts the
// OBSERVATION routes (/amicode/fleet/status + /amicode/fleet/sessions) with NO
// entitlement. #1478 deferred the NAMED POSTURE to this slice: the base peer's
// status surface must report a named posture snapshot (the D6 vocabulary:
// "fleet" | "degraded" | "standalone"), not omit it.
// ═══════════════════════════════════════════════════════════════════════════
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { createAmicodeService } from "../src/amicode_service";
import { serverAuthToken } from "../src/server_auth";
import type { FleetPostureState } from "../src/amicode_service/fleet_posture";

interface MockOrigin {
  url: string;
  stop(): Promise<void>;
}
function startMockEngine(enginePassword: string, sessions: unknown[]): Promise<MockOrigin> {
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? "";
    if (auth !== serverAuthHeader(enginePassword)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/session")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(sessions));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, stop: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
function startMockPeer(token: string, sessions: unknown[]): Promise<MockOrigin> {
  const server = http.createServer((req, res) => {
    if ((req.headers.authorization ?? "") !== serverAuthHeader(token)) {
      res.writeHead(401);
      res.end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(sessions));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, stop: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe("AC3 — a headless base peer boots the observation infra and records a named posture", () => {
  let localEngine: MockOrigin;
  let studioPeer: MockOrigin;
  let savedHubFile: string | undefined;
  let hubRoot: string;

  const NAMED_POSTURE_STATES: ReadonlySet<FleetPostureState> = new Set(["fleet", "degraded", "standalone"]);

  beforeEach(async () => {
    localEngine = await startMockEngine("engine-mint-password", [
      { id: "ses-local", title: "local", time: { created: 1, updated: 2 } },
    ]);
    studioPeer = await startMockPeer("tok-studio", [
      { id: "ses-studio", title: "studio", time: { created: 3, updated: 4 } },
    ]);
    hubRoot = tmproot();
    savedHubFile = process.env.AMICO_FLEET_HUB_FILE;
    process.env.AMICO_FLEET_HUB_FILE = join(hubRoot, "hub-cred-absent.json");
  });
  afterEach(async () => {
    await localEngine.stop();
    await studioPeer.stop();
    if (savedHubFile === undefined) delete process.env.AMICO_FLEET_HUB_FILE;
    else process.env.AMICO_FLEET_HUB_FILE = savedHubFile;
  });

  // The base-activation authority: a NON-client peer with ≥1 verified serving
  // peer beyond self — NO amicissimo entitlement (baseStudioActivates true).
  function bootHeadlessBase() {
    return createAmicodeService({
      password: "service-own-mint",
      engine: { password: "engine-mint-password", getUrl: () => localEngine.url },
      fleet: {
        entitlements: [], // NO entitlement — the base authority, not premium
        hub: { getUrl: () => undefined }, // a base peer, no hub upstream
        fleetPeers: {
          localMachineId: "my-macbook",
          getServingPeers: () => [{ machineId: "the-studio" }],
          readPeerToken: (id: string) =>
            id === "the-studio"
              ? { ok: true as const, credential: { baseUrl: studioPeer.url, token: "tok-studio" } }
              : { ok: false as const },
          rosterLookup: (id: string) => (id === "the-studio" ? { name: "The Studio" } : undefined),
        },
      },
    });
  }

  it("boots the observation routes headless (no editor host) — status + sessions serve", async () => {
    const svc = bootHeadlessBase();
    const o = (await svc.start()).toString().replace(/\/$/, "");
    const engineHeader = { Authorization: `Basic ${serverAuthToken("engine-mint-password")}` };
    try {
      const status = await fetch(`${o}/amicode/fleet/status`, { headers: engineHeader });
      expect(status.status).toBe(200);
      const sessions = await fetch(`${o}/amicode/fleet/sessions`, { headers: engineHeader });
      expect(sessions.status).toBe(200);
      const body = (await sessions.json()) as { sources: Record<string, { present: boolean }> };
      // the verified peer is observable from the headless base peer
      expect(body.sources["the-studio"].present).toBe(true);
    } finally {
      await svc.stop();
    }
  });

  it("records a NAMED posture on its status surface (the #1478-deferred contract)", async () => {
    const svc = bootHeadlessBase();
    const o = (await svc.start()).toString().replace(/\/$/, "");
    const engineHeader = { Authorization: `Basic ${serverAuthToken("engine-mint-password")}` };
    try {
      const status = await fetch(`${o}/amicode/fleet/status`, { headers: engineHeader });
      const body = (await status.json()) as { ok: boolean; posture?: { state?: string } };
      expect(body.ok).toBe(true);
      // AC3: the base peer records a NAMED posture — not an omitted field.
      expect(body.posture).toBeDefined();
      expect(body.posture!.state).toBeDefined();
      expect(NAMED_POSTURE_STATES.has(body.posture!.state as FleetPostureState)).toBe(true);
    } finally {
      await svc.stop();
    }
  });

  // AC4: hub/client compatibility unchanged — a fleet-of-one (zero serving
  // peers beyond self) is NOT base-activated, so its /amicode/fleet/status 404s
  // exactly as before (local-only, byte-compatible). The named-posture addition
  // must not accidentally activate a no-peer base install.
  it("AC4: a fleet-of-one (zero serving peers) is NOT base-activated — status 404s (local-only, unchanged)", async () => {
    const svc = createAmicodeService({
      password: "service-own-mint",
      engine: { password: "engine-mint-password", getUrl: () => localEngine.url },
      fleet: {
        entitlements: [],
        hub: { getUrl: () => undefined },
        fleetPeers: {
          localMachineId: "my-macbook",
          getServingPeers: () => [], // fleet-of-one: no serving peer beyond self
          readPeerToken: () => ({ ok: false as const }),
          rosterLookup: () => undefined,
        },
      },
    });
    const o = (await svc.start()).toString().replace(/\/$/, "");
    const engineHeader = { Authorization: `Basic ${serverAuthToken("engine-mint-password")}` };
    try {
      const status = await fetch(`${o}/amicode/fleet/status`, { headers: engineHeader });
      expect(status.status).toBe(404); // never activated → the route does not exist
    } finally {
      await svc.stop();
    }
  });
});
