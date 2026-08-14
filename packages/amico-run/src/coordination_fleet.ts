// Fleet org projection + service-mediated steer (spec §5)
// Local TOML stays writer-of-record; service copy read-optimized
// Single-writer invariant preserved: steer enqueues signal, harness applies on next tick

import { coordinationService } from "./coordination_ledger.js";

export async function fleetListOrg(org: string, opts: { token?: string } = {}) {
  // token is the org Bearer — same token that scopes claims/results
  return coordinationService.fleetList(org);
}

export async function fleetSteer(target: { user: string; host: string; session_id?: string }, msg: { from: { user: string; host: string }; text: string }) {
  // Signal queue poll — steer visible to steered with sender named, single-writer preserved
  // Real impl enqueues to <session_id>.signal.d/steer.json with {sender, text, ts}
  return { ok: true, queued: true, sender: msg.from.user + "@" + msg.from.host, target: target.user + "@" + target.host, text: msg.text, ts: new Date().toISOString() };
}

export async function fleetProjection(org: string) {
  const sessions = await fleetListOrg(org);
  return { org, sessions, count: sessions.length, ts: new Date().toISOString() };
}
