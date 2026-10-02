// `amico fleet revoke <machine_id>` (#1438, ADR 0032 §D5) — the revocation +
// rotation surface. Distrusting one machine no longer re-keys the fleet:
//
//   1. LOCAL expulsion — drop this machine's issued grant for X AND add X to
//      the mint-list bar (§D4), on ~/.amico/fleet-peer-tokens.json. This is
//      authoritative for THIS machine (single-writer of the registry granting
//      access to itself) and always applies.
//   2. FAN-OUT — because a machine is the single writer of its own registry,
//      expelling X fleet-wide means EVERY serving peer drops its own issued
//      entry for X. This verb fans the revocation out to each serving peer's
//      receiving endpoint (POST /amicode/fleet/revoke?machine_id=X); each peer
//      applies it to its OWN registry (no machine writes another's).
//
// amico-run cannot import the extension's fleet_issued_tokens.ts, so the LOCAL
// registry mutation is a small self-contained writer over the SAME file shape
// (the githubAppConfigFile cross-package-duplication precedent). The roster read
// is shared via @amicode/schema.
import * as fs from "node:fs";
import * as path from "node:path";
import {
  fleetRosterCachePath,
  parseRosterDocument,
  placementDescriptor,
  type RosterRow,
} from "@amicode/schema";
import type { VerbResult } from "./verbs.js";

/** A serving+reachable peer the fan-out targets. */
export interface ServingPeer {
  machine_id: string;
  origin: string;
}

export interface FanOutResult {
  peer: string;
  ok: boolean;
  error?: string;
}

export interface FleetRevokeDeps {
  /** The local issued-token registry. Default: ~/.amico/fleet-peer-tokens.json
   *  (env $AMICO_FLEET_ISSUED_TOKEN_FILE). */
  registryFile?: string;
  /** ISO clock for the revoked_at stamp. Default: now. */
  now?: () => string;
  /** Resolve the serving+reachable peers to fan out to. Default: read the
   *  host-owned roster and keep serving∧reachable rows that carry a peer_origin. */
  listServingPeers?: () => Promise<ServingPeer[]>;
  /** Fan a revocation out to ONE peer. Default: POST
   *  <origin>/amicode/fleet/revoke?machine_id=X. */
  fanOutRevoke?: (peer: ServingPeer, machineId: string) => Promise<FanOutResult>;
  /** The HTTP impl for the default fan-out. Default: globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

const STORE_VERSION = 1;

function fail(errors: string[]): VerbResult {
  return { json: { verb: "fleet", subcommand: "revoke", ok: false, errors }, code: 64 };
}

function issuedRegistryPath(deps: FleetRevokeDeps): string {
  if (deps.registryFile) return deps.registryFile;
  const env = process.env.AMICO_FLEET_ISSUED_TOKEN_FILE;
  if (env && env.trim() !== "") return env;
  return path.join(require("node:os").homedir(), ".amico", "fleet-peer-tokens.json");
}

/** LOCAL expulsion: drop issued[X], set revoked[X] — atomic 0600, preserving
 *  unknown top-level keys (the same file contract the extension's registry
 *  writer honors). */
function revokeLocal(file: string, machineId: string, now: () => string): void {
  let doc: Record<string, unknown> = {};
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) doc = parsed as Record<string, unknown>;
    }
  } catch {
    doc = {};
  }
  const issued = { ...((typeof doc.issued === "object" && doc.issued !== null ? doc.issued : {}) as Record<string, unknown>) };
  delete issued[machineId];
  const revoked = { ...((typeof doc.revoked === "object" && doc.revoked !== null ? doc.revoked : {}) as Record<string, unknown>) };
  revoked[machineId] = { revoked_at: now() };
  const out = { ...doc, store_version: STORE_VERSION, issued, revoked };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Default serving-peer resolution: the host-owned roster's serving∧reachable
 *  rows that self-report a peer_origin (the HTTP target the fan-out reaches). */
function defaultListServingPeers(): ServingPeer[] {
  const rosterPath = fleetRosterCachePath();
  if (!fs.existsSync(rosterPath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(rosterPath, "utf8"));
  } catch {
    return [];
  }
  const doc = parseRosterDocument(parsed);
  if (!doc.ok) return [];
  const peers: ServingPeer[] = [];
  for (const row of doc.doc.rows as RosterRow[]) {
    const d = placementDescriptor(row);
    if (!d.serving || !d.reachable) continue;
    const origin = typeof row.peer_origin === "string" ? row.peer_origin.trim() : "";
    if (origin === "") continue; // SSH-only peers have no direct HTTP origin (out of scope here)
    peers.push({ machine_id: row.machine_id, origin });
  }
  return peers;
}

async function defaultFanOutRevoke(peer: ServingPeer, machineId: string, fetchImpl: typeof fetch): Promise<FanOutResult> {
  const url = `${peer.origin.replace(/\/+$/, "")}/amicode/fleet/revoke?machine_id=${encodeURIComponent(machineId)}`;
  try {
    const res = await fetchImpl(url, { method: "POST" });
    return res.ok ? { peer: peer.origin, ok: true } : { peer: peer.origin, ok: false, error: `HTTP ${res.status}` };
  } catch (e) {
    return { peer: peer.origin, ok: false, error: (e as Error).message };
  }
}

export async function fleetRevoke(argv: string[], deps: FleetRevokeDeps = {}): Promise<VerbResult> {
  const machineId = (argv[0] ?? "").trim();
  if (machineId === "" || machineId.startsWith("-")) {
    return fail(["`amico fleet revoke <machine_id>` requires a machine_id to revoke"]);
  }

  // 1. LOCAL expulsion (authoritative for this machine; always applies).
  revokeLocal(issuedRegistryPath(deps), machineId, deps.now ?? (() => new Date().toISOString()));

  // 2. FAN-OUT to every serving peer (each applies it to its own registry).
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const peers = await (deps.listServingPeers ?? (async () => defaultListServingPeers()))();
  const fan = deps.fanOutRevoke ?? ((peer, id) => defaultFanOutRevoke(peer, id, fetchImpl));
  const fanned_out = await Promise.all(peers.map((p) => fan(p, machineId)));

  const allOk = fanned_out.every((f) => f.ok);
  return {
    json: {
      verb: "fleet",
      subcommand: "revoke",
      ok: true, // local expulsion succeeded; per-peer fan-out status is itemized
      machine_id: machineId,
      revoked_local: true,
      fanned_out,
      note: allOk
        ? "revoked locally (dropped + mint-barred) and fanned out to every serving peer"
        : "revoked locally (dropped + mint-barred); one or more peers could not be reached — re-run once they are up (their tokens for this machine still authenticate there until then)",
    },
    code: 0,
  };
}
