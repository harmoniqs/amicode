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
import { describe, it, expect, beforeEach } from "vitest";
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
