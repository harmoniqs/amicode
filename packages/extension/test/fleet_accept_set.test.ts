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
