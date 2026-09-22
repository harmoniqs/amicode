// fleet_accept_set.test.ts (#1438, ADR 0032) — the peer-trust credential +
// accept-set BEHAVIORAL suite. This is the load-bearing seam the slice is
// judged on: the foundational stores (shared keyed-0600 primitive, reader
// peer-store, minter issued-token registry, enrollment nonce) tested as
// modules, and the accept-set tested as EXTERNAL BEHAVIOR by booting the real
// AmicodeServiceServer with fixture stores.
//
// NOT the transport-layer read-only-with-pointer credential-lapse model
// (amicode_service_fleet_posture.test.ts) — the PRD rejected that model for
// this credential; the revoked→NoPermissions vs unreachable→HubDown split is
// the app-layer accept-set outcome asserted here instead.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── the shared keyed-0600-store primitive (ADR 0032 §D1 "factor the shared
//    keyed-0600-store primitive rather than fork a third copy") ──────────────
import {
  readKeyedCollection,
  upsertKeyedEntry,
  deleteKeyedEntry,
  clearKeyedStoreFile,
} from "../src/amicode_service/keyed_store";

// ── the dedicated reader peer-token store (ADR 0032 §D1) ─────────────────────
import {
  readPeerToken,
  writePeerToken,
  clearPeerToken,
  peerTokenStorePath,
  PEER_TOKEN_STORE_VERSION,
} from "../src/amicode_service/fleet_peer_store";

function tmproot(): string {
  return mkdtempSync(join(tmpdir(), "amicode-accept-set-"));
}

describe("the shared keyed-0600-store primitive (ADR 0032 §D1)", () => {
  let file: string;
  beforeEach(() => {
    file = join(tmproot(), "keyed.json");
  });

  it("an absent store reads as an empty collection (never a throw)", () => {
    expect(readKeyedCollection(file, "peers")).toEqual({});
  });

  it("upsert writes the entry under the collection key, stamped, atomically", () => {
    upsertKeyedEntry(file, "peers", "mac-studio", { base_url: "http://h", token: "t" }, 1);
    const peers = readKeyedCollection(file, "peers");
    expect(peers["mac-studio"]).toEqual({ base_url: "http://h", token: "t" });
    const doc = JSON.parse(readFileSync(file, "utf8")) as { store_version?: number };
    expect(doc.store_version).toBe(1);
  });

  it("the file is written 0600 (secrets never land world-readable)", () => {
    upsertKeyedEntry(file, "issued", "m1", { token: "s" }, 1);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("upsert preserves other entries AND unknown top-level keys (bidirectional courtesy)", () => {
    writeFileSync(file, JSON.stringify({ store_version: 1, peers: { a: { token: "x" } }, future_key: 42 }));
    upsertKeyedEntry(file, "peers", "b", { token: "y" }, 1);
    const peers = readKeyedCollection(file, "peers");
    expect(peers.a).toEqual({ token: "x" });
    expect(peers.b).toEqual({ token: "y" });
    const doc = JSON.parse(readFileSync(file, "utf8")) as { future_key?: number };
    expect(doc.future_key).toBe(42);
  });

  it("delete removes one entry; an absent key is an idempotent no-op", () => {
    upsertKeyedEntry(file, "issued", "m1", { token: "s" }, 1);
    upsertKeyedEntry(file, "issued", "m2", { token: "s2" }, 1);
    deleteKeyedEntry(file, "issued", "m1", 1);
    expect(readKeyedCollection(file, "issued")).toEqual({ m2: { token: "s2" } });
    deleteKeyedEntry(file, "issued", "does-not-exist", 1); // no throw
    expect(readKeyedCollection(file, "issued")).toEqual({ m2: { token: "s2" } });
  });

  it("a corrupt file degrades to an empty collection, never a throw", () => {
    writeFileSync(file, "{ this is not json");
    expect(readKeyedCollection(file, "peers")).toEqual({});
  });

  it("clear removes the whole file; absent is a no-op", () => {
    upsertKeyedEntry(file, "peers", "a", { token: "x" }, 1);
    clearKeyedStoreFile(file);
    expect(existsSync(file)).toBe(false);
    clearKeyedStoreFile(file); // no throw
  });
});

describe("the reader peer-token store (ADR 0032 §D1 — dedicated, NOT attachment_credential)", () => {
  let root: string;
  let file: string;
  beforeEach(() => {
    root = tmproot();
    file = join(root, "fleet-peer-tokens-reader.json");
  });

  it("reads absent as a named absent outcome (never a throw, never a fabricated credential)", () => {
    expect(readPeerToken("mac-studio", { storeFile: file })).toEqual({ ok: false, reason: "absent" });
  });

  it("write then read round-trips one target's peer credential", () => {
    writePeerToken("mac-studio", { baseUrl: "http://studio:43117", token: "peer-tok" }, { storeFile: file });
    const r = readPeerToken("mac-studio", { storeFile: file });
    expect(r).toEqual({ ok: true, credential: { baseUrl: "http://studio:43117", token: "peer-tok" } });
  });

  it("an incomplete entry (missing token) is a named incomplete outcome", () => {
    writeFileSync(
      file,
      JSON.stringify({ store_version: PEER_TOKEN_STORE_VERSION, peers: { m: { base_url: "http://h", token: "" } } }),
    );
    expect(readPeerToken("m", { storeFile: file })).toEqual({ ok: false, reason: "incomplete" });
  });

  it("clear removes one target; other targets survive", () => {
    writePeerToken("a", { baseUrl: "http://a", token: "ta" }, { storeFile: file });
    writePeerToken("b", { baseUrl: "http://b", token: "tb" }, { storeFile: file });
    clearPeerToken("a", { storeFile: file });
    expect(readPeerToken("a", { storeFile: file }).ok).toBe(false);
    expect(readPeerToken("b", { storeFile: file }).ok).toBe(true);
  });

  it("the default store path is a dedicated file, distinct from the attachment-credential store", () => {
    const p = peerTokenStorePath({});
    expect(p).toMatch(/fleet-peer/);
    expect(p).not.toMatch(/attachment/);
  });
});

// ── the minter's issued-token registry (ADR 0032 §D1/§D4/§D5) ────────────────
import {
  mintPeerToken,
  readIssuedTokens,
  issuedTokenFor,
  hasIssuedToken,
  revokePeerToken,
  isMintBarred,
  issuedTokenRegistryPath,
  ISSUED_TOKEN_STORE_VERSION,
} from "../src/amicode_service/fleet_issued_tokens";

// ── the enrollment nonce (ADR 0032 §D4 — single-use, short-TTL bootstrap) ────
import {
  mintEnrollmentNonce,
  validateEnrollmentNonce,
  consumeEnrollmentNonce,
} from "../src/amicode_service/fleet_enrollment_nonce";

describe("the minter's issued-token registry (ADR 0032 §D1/§D5 — revocable, single-writer, 0600)", () => {
  let file: string;
  beforeEach(() => {
    file = join(tmproot(), "fleet-peer-tokens.json");
  });

  it("mints a per-peer token keyed by machine_id and records it in the issued registry", () => {
    const r = mintPeerToken("mac-studio", { registryFile: file, tokenFactory: () => "TOK-1" });
    expect(r).toEqual({ ok: true, token: "TOK-1", machineId: "mac-studio" });
    expect(issuedTokenFor("mac-studio", { registryFile: file })).toBe("TOK-1");
    expect(hasIssuedToken("mac-studio", { registryFile: file })).toBe(true);
  });

  it("the registry file is 0600", () => {
    mintPeerToken("m", { registryFile: file, tokenFactory: () => "T" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("readIssuedTokens returns every non-revoked issued token (the accept-set input)", () => {
    mintPeerToken("a", { registryFile: file, tokenFactory: () => "TA" });
    mintPeerToken("b", { registryFile: file, tokenFactory: () => "TB" });
    expect(readIssuedTokens({ registryFile: file }).sort()).toEqual(["TA", "TB"]);
  });

  it("revoke drops the entry AND bars re-minting (the §D4 mint-list bar); the token is gone from the accept-set", () => {
    mintPeerToken("evil", { registryFile: file, tokenFactory: () => "TE" });
    revokePeerToken("evil", { registryFile: file });
    expect(hasIssuedToken("evil", { registryFile: file })).toBe(false);
    expect(readIssuedTokens({ registryFile: file })).not.toContain("TE");
    expect(isMintBarred("evil", { registryFile: file })).toBe(true);
  });

  it("a barred machine_id is REFUSED a fresh mint (revocation contains a compromise, never re-mintable around)", () => {
    mintPeerToken("evil", { registryFile: file, tokenFactory: () => "TE" });
    revokePeerToken("evil", { registryFile: file });
    const r = mintPeerToken("evil", { registryFile: file, tokenFactory: () => "TE2" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("mint-barred");
    expect(hasIssuedToken("evil", { registryFile: file })).toBe(false);
  });

  it("the default registry path is the dedicated minter file, distinct from the reader store", () => {
    const p = issuedTokenRegistryPath({});
    expect(p).toMatch(/fleet-peer-tokens\.json$/);
    expect(p).not.toMatch(/reader/);
  });
});

describe("the enrollment nonce (ADR 0032 §D4 — single-use, short-TTL bootstrap, NOT the Fleet token)", () => {
  let file: string;
  beforeEach(() => {
    file = join(tmproot(), "fleet-enrollment-nonces.json");
  });

  it("a freshly minted nonce validates (present, unused, unexpired)", () => {
    const n = mintEnrollmentNonce({ storeFile: file, ttlMs: 60_000, now: () => 1000, nonceFactory: () => "N1" });
    expect(n).toBe("N1");
    expect(validateEnrollmentNonce("N1", { storeFile: file, now: () => 5000 })).toBe(true);
  });

  it("an expired nonce does NOT validate (short-TTL)", () => {
    mintEnrollmentNonce({ storeFile: file, ttlMs: 1000, now: () => 1000, nonceFactory: () => "N1" });
    expect(validateEnrollmentNonce("N1", { storeFile: file, now: () => 2001 })).toBe(false);
  });

  it("an unknown nonce does NOT validate", () => {
    expect(validateEnrollmentNonce("never-minted", { storeFile: file, now: () => 1 })).toBe(false);
  });

  it("consume is single-use: the first consume succeeds, the second is refused", () => {
    mintEnrollmentNonce({ storeFile: file, ttlMs: 60_000, now: () => 1000, nonceFactory: () => "N1" });
    expect(consumeEnrollmentNonce("N1", { storeFile: file, now: () => 2000 })).toBe(true);
    expect(consumeEnrollmentNonce("N1", { storeFile: file, now: () => 2000 })).toBe(false);
    expect(validateEnrollmentNonce("N1", { storeFile: file, now: () => 2000 })).toBe(false);
  });

  it("validate does NOT consume (a probe leaves the nonce usable)", () => {
    mintEnrollmentNonce({ storeFile: file, ttlMs: 60_000, now: () => 1000, nonceFactory: () => "N1" });
    expect(validateEnrollmentNonce("N1", { storeFile: file, now: () => 2000 })).toBe(true);
    expect(consumeEnrollmentNonce("N1", { storeFile: file, now: () => 2000 })).toBe(true);
  });
});

// ── the accept-set validator on the SERVICE boundary (ADR 0032 §D2/§D3) ──────
import { AmicodeServiceServer } from "../src/amicode_service/server";
import { serverAuthHeader } from "../src/server_auth";
import { hubUpstreamAuthHeader } from "../src/amicode_service/hub_credential";
import {
  buildAcceptSet,
  acceptSetPhase,
  closeAcceptSet,
  rollbackAcceptSet,
} from "../src/amicode_service/fleet_accept_set";
import { peerTokenMintHandler, MINT_ENDPOINT_PATH } from "../src/amicode_service/fleet_mint_route";

interface Booted {
  origin: string;
  server: AmicodeServiceServer;
  files: { issued: string; phase: string; nonce: string; peerStore: string };
  hubToken: string;
  stop: () => Promise<void>;
}

async function bootAcceptSet(opts: { authMode?: "open" | "credential"; password?: string } = {}): Promise<Booted> {
  const root = tmproot();
  const files = {
    issued: join(root, "fleet-peer-tokens.json"),
    phase: join(root, "fleet-accept-set.json"),
    nonce: join(root, "fleet-enrollment-nonces.json"),
    peerStore: join(root, "fleet-peer-tokens-reader.json"),
  };
  const hubToken = "hub-transitional-token";
  const acceptSet = buildAcceptSet({
    issuedRegistryFile: files.issued,
    phaseStateFile: files.phase,
    enrollmentNonceFile: files.nonce,
    hubCredentialToken: () => hubToken,
  });
  const server = new AmicodeServiceServer({
    password: opts.password ?? "service-own-mint",
    authMode: opts.authMode ?? "open", // a server today runs auth=open — additive layers on top
    acceptSet,
  });
  server.add("GET", "/amicode/ping", () => ({ body: JSON.stringify({ ok: true }) }));
  server.add(
    "POST",
    MINT_ENDPOINT_PATH,
    peerTokenMintHandler({ issuedRegistryFile: files.issued, enrollmentNonceFile: files.nonce }),
  );
  const origin = (await server.start()).toString().replace(/\/$/, "");
  return { origin, server, files, hubToken, stop: () => server.stop() };
}

const peerHeader = (token: string) => ({ Authorization: serverAuthHeader(token) });

describe("accept-set — ADDITIVE posture (ADR 0032 §D3.1: peer tokens accepted in addition to auth=open)", () => {
  let b: Booted;
  beforeEach(async () => {
    b = await bootAcceptSet();
  });

  it("phase defaults to additive", () => {
    expect(acceptSetPhase({ phaseStateFile: b.files.phase })).toBe("additive");
  });

  it("AC5: a peer-token request AND a hub-credential request both succeed (backcompat mid-migration)", async () => {
    const mint = mintPeerToken("peer-a", { registryFile: b.files.issued, tokenFactory: () => "PEER-A-TOK" });
    expect(mint.ok).toBe(true);
    const peer = await fetch(`${b.origin}/amicode/ping`, { headers: peerHeader("PEER-A-TOK") });
    expect(peer.status).toBe(200);
    const hub = await fetch(`${b.origin}/amicode/ping`, { headers: { Authorization: hubUpstreamAuthHeader(b.hubToken) } });
    expect(hub.status).toBe(200);
  });

  it("additive still accepts anonymous (auth=open is not yet withdrawn)", async () => {
    const res = await fetch(`${b.origin}/amicode/ping`);
    expect(res.status).toBe(200);
  });

  afterEach(() => b?.stop());
});

describe("accept-set — CLOSED posture (ADR 0032 §D3.2: require an accept-set member)", () => {
  let b: Booted;
  beforeEach(async () => {
    b = await bootAcceptSet();
    // seed a valid peer token, then close
    mintPeerToken("peer-a", { registryFile: b.files.issued, tokenFactory: () => "PEER-A-TOK-000000000000" });
    closeAcceptSet({ phaseStateFile: b.files.phase });
  });

  it("AC7: after close an UNAUTHENTICATED request is refused (401); the local mint still authenticates", async () => {
    const anon = await fetch(`${b.origin}/amicode/ping`);
    expect(anon.status).toBe(401);
    const local = await fetch(`${b.origin}/amicode/ping`, { headers: peerHeader("service-own-mint") });
    expect(local.status).toBe(200);
  });

  it("a non-revoked peer token still authenticates after close", async () => {
    const res = await fetch(`${b.origin}/amicode/ping`, { headers: peerHeader("PEER-A-TOK-000000000000") });
    expect(res.status).toBe(200);
  });

  it("AC8: the transitional hub credential is REFUSED after close (withdrawn in the close step)", async () => {
    const res = await fetch(`${b.origin}/amicode/ping`, { headers: { Authorization: hubUpstreamAuthHeader(b.hubToken) } });
    expect(res.status).toBe(401);
  });

  it("AC2: a revoked peer token is refused (401) after close", async () => {
    revokePeerToken("peer-a", { registryFile: b.files.issued });
    const res = await fetch(`${b.origin}/amicode/ping`, { headers: peerHeader("PEER-A-TOK-000000000000") });
    expect(res.status).toBe(401);
  });

  afterEach(() => b?.stop());

  it("AC3 observable: a wrong-LENGTH token AND an equal-length-WRONG token both 401 (constant-time proxy)", async () => {
    const wrongLen = await fetch(`${b.origin}/amicode/ping`, { headers: peerHeader("short") });
    expect(wrongLen.status).toBe(401);
    // same length as PEER-A-TOK-000000000000, different bytes
    const equalLenWrong = await fetch(`${b.origin}/amicode/ping`, { headers: peerHeader("XXXXXXXXXXXXXXXXXXXXXXX") });
    expect("PEER-A-TOK-000000000000".length).toBe("XXXXXXXXXXXXXXXXXXXXXXX".length);
    expect(equalLenWrong.status).toBe(401);
  });
});

describe("accept-set — revocation CURRENCY (ADR 0032 §D2/AC4: per-request read, no cache)", () => {
  it("AC4: mint → 200; delete the registry entry; the IMMEDIATELY following request → 401", async () => {
    const b = await bootAcceptSet();
    closeAcceptSet({ phaseStateFile: b.files.phase });
    mintPeerToken("peer-x", { registryFile: b.files.issued, tokenFactory: () => "PEER-X-TOK" });
    const first = await fetch(`${b.origin}/amicode/ping`, { headers: peerHeader("PEER-X-TOK") });
    expect(first.status).toBe(200);
    revokePeerToken("peer-x", { registryFile: b.files.issued }); // delete the entry
    const next = await fetch(`${b.origin}/amicode/ping`, { headers: peerHeader("PEER-X-TOK") });
    expect(next.status).toBe(401); // no cache — the very next request sees the revocation
    await b.stop();
  });
});

describe("accept-set — the enrollment-nonce mint endpoint (ADR 0032 §D4/AC1/AC10)", () => {
  it("AC1: a joining machine mints its peer token via a single-use nonce; the token is recorded", async () => {
    const b = await bootAcceptSet();
    const nonce = mintEnrollmentNonce({ storeFile: b.files.nonce, nonceFactory: () => "NONCE-1", ttlMs: 60_000 });
    const res = await fetch(`${b.origin}${MINT_ENDPOINT_PATH}?machine_id=joiner&enrollment_nonce=${nonce}`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; token: string };
    expect(body.ok).toBe(true);
    expect(typeof body.token).toBe("string");
    expect(issuedTokenFor("joiner", { registryFile: b.files.issued })).toBe(body.token);
    // single-use: the same nonce cannot mint again
    const again = await fetch(`${b.origin}${MINT_ENDPOINT_PATH}?machine_id=joiner2&enrollment_nonce=${nonce}`, {
      method: "POST",
    });
    expect(again.status).toBe(401);
    await b.stop();
  });

  it("AC10: after CLOSE, a newly-enrolling machine still obtains its peer token via the nonce endpoint", async () => {
    const b = await bootAcceptSet();
    closeAcceptSet({ phaseStateFile: b.files.phase });
    const nonce = mintEnrollmentNonce({ storeFile: b.files.nonce, nonceFactory: () => "NONCE-2", ttlMs: 60_000 });
    const res = await fetch(`${b.origin}${MINT_ENDPOINT_PATH}?machine_id=late-joiner&enrollment_nonce=${nonce}`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; token: string };
    expect(body.ok).toBe(true);
    // and the freshly-minted token authenticates on the closed boundary
    const ping = await fetch(`${b.origin}/amicode/ping`, { headers: peerHeader(body.token) });
    expect(ping.status).toBe(200);
    await b.stop();
  });

  it("a mint for a mint-barred machine_id is refused (403), even with a valid nonce", async () => {
    const b = await bootAcceptSet();
    mintPeerToken("bad", { registryFile: b.files.issued, tokenFactory: () => "T" });
    revokePeerToken("bad", { registryFile: b.files.issued });
    const nonce = mintEnrollmentNonce({ storeFile: b.files.nonce, nonceFactory: () => "NONCE-3", ttlMs: 60_000 });
    const res = await fetch(`${b.origin}${MINT_ENDPOINT_PATH}?machine_id=bad&enrollment_nonce=${nonce}`, {
      method: "POST",
    });
    expect(res.status).toBe(403);
    await b.stop();
  });
});

// ── the reader-side outcome split + the readiness gate + the rollback ────────
import { readFileSync as _rf } from "node:fs";
import {
  classifyPeerOutcome,
  evaluateReadiness,
  PEER_OUTCOME_NO_PERMISSIONS,
  PEER_OUTCOME_HUB_DOWN,
} from "../src/amicode_service/fleet_accept_set";
import { writePeerToken } from "../src/amicode_service/fleet_peer_store";
import type { RosterRow } from "@amicode/schema";

function servingReachable(machineId: string): RosterRow {
  return {
    machine_id: machineId,
    name: machineId,
    server_mode: "server",
    capabilities: ["serving"],
    sshAlias: machineId,
    transport: "ssh",
    last_report: "2026-09-22T00:00:00Z",
    health: "reachable",
  };
}

describe("AC2 — reader-side outcome split (revoked→NoPermissions vs unreachable→HubDown, never conflated)", () => {
  it("a 401 on the peer hop is REVOKED (NoPermissions) — a suspected compromise reads as revocation, not an outage", () => {
    const o = classifyPeerOutcome({ httpStatus: 401 });
    expect(o.kind).toBe("revoked");
    if (o.kind === "revoked") expect(o.outcome).toBe(PEER_OUTCOME_NO_PERMISSIONS);
  });

  it("a transport failure is UNREACHABLE (HubDown) — a DISTINCT external outcome", () => {
    const o = classifyPeerOutcome({ transportError: true });
    expect(o.kind).toBe("unreachable");
    if (o.kind === "unreachable") expect(o.outcome).toBe(PEER_OUTCOME_HUB_DOWN);
  });

  it("the two outcomes are never the same string (the split is observable)", () => {
    expect(PEER_OUTCOME_NO_PERMISSIONS).not.toBe(PEER_OUTCOME_HUB_DOWN);
  });

  it("a 2xx is authorized", () => {
    expect(classifyPeerOutcome({ httpStatus: 200 }).kind).toBe("authorized");
  });
});

describe("AC6 — the readiness gate (single machine_id vocabulary, both stores, refuses vacuously)", () => {
  let issued: string;
  let peerStore: string;
  beforeEach(() => {
    const root = tmproot();
    issued = join(root, "fleet-peer-tokens.json");
    peerStore = join(root, "fleet-peer-tokens-reader.json");
  });

  function bothSides(id: string): void {
    mintPeerToken(id, { registryFile: issued, tokenFactory: () => `${id}-tok` });
    writePeerToken(id, { baseUrl: `http://${id}`, token: `${id}-peer` }, { storeFile: peerStore });
  }

  it("a 3-peer fixture with one side MISSING refuses close (401-equivalent verdict)", () => {
    bothSides("p1");
    bothSides("p2");
    // p3: minter side only — the reader peer-store entry is missing
    mintPeerToken("p3", { registryFile: issued, tokenFactory: () => "p3-tok" });
    const v = evaluateReadiness({
      rosterRows: [servingReachable("p1"), servingReachable("p2"), servingReachable("p3")],
      issuedRegistryFile: issued,
      peerStoreFile: peerStore,
    });
    expect(v.closeable).toBe(false);
    if (!v.closeable) expect(v.blockers.some((b) => b.machine_id === "p3" && b.reason === "missing-peer-token")).toBe(true);
  });

  it("adding the missing side makes close SUCCEED", () => {
    bothSides("p1");
    bothSides("p2");
    bothSides("p3"); // now both sides present for all three
    const v = evaluateReadiness({
      rosterRows: [servingReachable("p1"), servingReachable("p2"), servingReachable("p3")],
      issuedRegistryFile: issued,
      peerStoreFile: peerStore,
    });
    expect(v.closeable).toBe(true);
    if (v.closeable) expect(v.resolved.sort()).toEqual(["p1", "p2", "p3"]);
  });

  it("a serving row whose machine_id cannot be resolved REFUSES close (never satisfies it vacuously)", () => {
    const unresolvable = { ...servingReachable("x"), machine_id: "  " };
    const v = evaluateReadiness({ rosterRows: [unresolvable], issuedRegistryFile: issued, peerStoreFile: peerStore });
    expect(v.closeable).toBe(false);
    if (!v.closeable) expect(v.blockers.some((b) => b.reason === "unresolvable-machine-id")).toBe(true);
  });

  it("non-serving / unreachable rows are ignored; self is excluded", () => {
    const notServing: RosterRow = { ...servingReachable("q1"), capabilities: [] };
    const unreachable: RosterRow = { ...servingReachable("q2"), health: "down" };
    const v = evaluateReadiness({
      rosterRows: [notServing, unreachable, servingReachable("self")],
      issuedRegistryFile: issued,
      peerStoreFile: peerStore,
      selfMachineId: "self",
    });
    expect(v.closeable).toBe(true); // nothing to gate on
  });
});

describe("AC9 — the documented rollback (401→200 deterministic transition)", () => {
  it("a peer stranded post-close (registry missing one side) 401s; rollback re-opens additive and it 200s", async () => {
    const b = await bootAcceptSet();
    // the stranded peer holds NO issued token here — post-close it cannot authenticate
    closeAcceptSet({ phaseStateFile: b.files.phase });
    const stranded = await fetch(`${b.origin}/amicode/ping`, { headers: peerHeader("stranded-peer-token") });
    expect(stranded.status).toBe(401); // stranded under close
    // the documented rollback re-opens the additive posture
    rollbackAcceptSet({ phaseStateFile: b.files.phase });
    expect(acceptSetPhase({ phaseStateFile: b.files.phase })).toBe("additive");
    const afterRollback = await fetch(`${b.origin}/amicode/ping`, { headers: peerHeader("stranded-peer-token") });
    expect(afterRollback.status).toBe(200); // the same request that 401'd now succeeds
    await b.stop();
  });
});

describe("AC3 structural — the service validator routes through timingSafeEqual + a length guard (not ===)", () => {
  it("server.ts uses crypto timingSafeEqual with a length guard, and never a raw === token compare", () => {
    const src = _rf(join(__dirname, "..", "src", "amicode_service", "server.ts"), "utf8");
    // the length guard precedes the constant-time compare (mirroring :244)
    expect(src).toMatch(/given\.length === want\.length && timingSafeEqual\(given, want\)/);
    // the accept-set membership test lives on the constant-time helper
    expect(src).toMatch(/matchesConstantTime/);
    // no plaintext string-equality of the decoded credential (the base-opencode
    // `===` anti-pattern the overlay replaces) — comparisons go through the buffer
    expect(src).not.toMatch(/given\.toString\(\)\s*===/);
    expect(src).not.toMatch(/\.password\.value\s*===/);
  });
});

// ── the peer-side receiving revoke endpoint (the §D5 fan-out lands here) ──────
import { peerRevokeHandler, PEER_REVOKE_PATH } from "../src/amicode_service/fleet_mint_route";

describe("AC2 — the fan-out lands: a peer applies a revocation to its OWN registry", () => {
  it("POST /amicode/fleet/revoke drops + bars the machine_id; its token then 401s and re-mint is barred", async () => {
    const b = await bootAcceptSet();
    server: {
      b.server.add(
        "POST",
        PEER_REVOKE_PATH,
        peerRevokeHandler({ issuedRegistryFile: b.files.issued }),
      );
    }
    mintPeerToken("victim", { registryFile: b.files.issued, tokenFactory: () => "VICTIM-TOK-0000000000" });
    closeAcceptSet({ phaseStateFile: b.files.phase });
    // the victim authenticates before the fan-out
    expect((await fetch(`${b.origin}/amicode/ping`, { headers: peerHeader("VICTIM-TOK-0000000000") })).status).toBe(200);
    // the fan-out lands (authorized by the local mint — the revoking operator's hop)
    const revoke = await fetch(`${b.origin}${PEER_REVOKE_PATH}?machine_id=victim`, {
      method: "POST",
      headers: peerHeader("service-own-mint"),
    });
    expect(revoke.status).toBe(200);
    // the victim's token is gone from the accept-set → 401 on the next request
    expect((await fetch(`${b.origin}/amicode/ping`, { headers: peerHeader("VICTIM-TOK-0000000000") })).status).toBe(401);
    // and the victim is barred from re-minting (the §D4 mint-list bar)
    const nonce = mintEnrollmentNonce({ storeFile: b.files.nonce, nonceFactory: () => "N-RE", ttlMs: 60_000 });
    const remint = await fetch(`${b.origin}${MINT_ENDPOINT_PATH}?machine_id=victim&enrollment_nonce=${nonce}`, {
      method: "POST",
      headers: peerHeader("service-own-mint"),
    });
    expect(remint.status).toBe(403);
    await b.stop();
  });
});
