import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ============================================================================
// Fleet remote-CREATE-leg E2E (#1643, completes #1484 AC3) — the physical proof
// that the new pre-flight gate routes creation correctly on REAL two-peer
// hardware. PAIRED with #1489's full release E2E (fleet_two_peer_e2e.test.ts),
// NOT a duplicate: #1489 owns the full independent-peer user path; THIS file
// owns only the create-routing leg — the creation-target gate resolves the
// discovered peer to a routable `remote` target and the peer-home-base gate
// resolves its working directory, so an owner-header-armed create would land
// on the peer (asserted hermetically in session_remote_create_wire.test.ts).
//
// Opt-in: AMICODE_E2E_FLEET=1. Unset → the whole suite skips cleanly (CI green).
// Set → every assertion is non-skipped; a failed physical check is a NAMED
// failure, never a waived mock.
// ============================================================================

const FLEET_E2E = process.env.AMICODE_E2E_FLEET === "1";

const LOCAL_ENDPOINT = process.env.AMICODE_FLEET_LOCAL ?? "http://127.0.0.1:4096";
const FETCH_TIMEOUT_MS = 15_000;

const READER_TOKENS_PATH = join(homedir(), ".amico", "fleet-peer-tokens-reader.json");
const LIFECYCLE_GRANTS_PATH = join(homedir(), ".amico", "fleet-lifecycle-grants.json");

async function fleetFetch(
  url: string,
  opts?: { headers?: Record<string, string>; timeout?: number },
): Promise<{ ok: boolean; status: number; json: () => unknown }> {
  const res = await fetch(url, {
    headers: opts?.headers,
    signal: AbortSignal.timeout(opts?.timeout ?? FETCH_TIMEOUT_MS),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, json: () => JSON.parse(body) };
}

/** Discover the remote peer's machine_id from the reader token store. */
function discoverRemotePeerId(): string {
  if (!existsSync(READER_TOKENS_PATH)) throw new Error(`reader-tokens-absent: ${READER_TOKENS_PATH}`);
  const raw = JSON.parse(readFileSync(READER_TOKENS_PATH, "utf8"));
  const peers = raw?.peers ?? {};
  const ids = Object.keys(peers);
  if (ids.length === 0) throw new Error("reader-tokens-empty");
  return ids[0];
}

describe.skipIf(!FLEET_E2E)("slow: fleet remote-create leg E2E (#1643, paired with #1489)", () => {
  let peerId: string;

  beforeAll(() => {
    peerId = discoverRemotePeerId();
    // An active control grant to the peer is the precondition for a remote
    // create (else the gate correctly returns insufficient-scope/no-grant).
    if (!existsSync(LIFECYCLE_GRANTS_PATH)) {
      throw new Error(`lifecycle-grants-absent: ${LIFECYCLE_GRANTS_PATH} — no control grant to route a remote create`);
    }
  });

  it("the local creation-target gate resolves the discovered peer to a routable REMOTE target", async () => {
    const res = await fleetFetch(
      `${LOCAL_ENDPOINT}/amicode/fleet/creation-target?machine=${encodeURIComponent(peerId)}`,
    );
    expect(res.ok).toBe(true);
    const body = res.json() as { ok: boolean; target?: { kind: string; machineId?: string; reason?: string } };
    expect(body.ok).toBe(true);
    // With an active control grant + a reachable peer this MUST be remote. If it
    // is blocked, the reason is the physical truth to fix (revoked/observe/down)
    // — a named failure, never a silent local create.
    expect(body.target?.kind, `gate returned ${JSON.stringify(body.target)}`).toBe("remote");
    expect(body.target?.machineId).toBe(peerId);
  });

  it("the local peer-home-base gate resolves the peer's working directory (else no-remote-root is the named truth)", async () => {
    const res = await fleetFetch(
      `${LOCAL_ENDPOINT}/amicode/fleet/peer-home-base?machine=${encodeURIComponent(peerId)}`,
    );
    expect(res.ok).toBe(true);
    const body = res.json() as { ok: boolean; directory?: string; reason?: string };
    // Either a resolved directory (create can proceed) or an HONEST no-remote-root.
    if (body.ok) {
      expect(typeof body.directory).toBe("string");
      expect(body.directory && body.directory.length > 0).toBe(true);
    } else {
      expect(body.reason).toBe("no-remote-root");
    }
  });
});
