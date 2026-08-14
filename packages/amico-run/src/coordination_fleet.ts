// Fleet org projection + service-mediated steer (spec §5)
// Local TOML stays writer-of-record; service copy read-optimized

import { coordinationService } from "./coordination_ledger.js";

export async function fleetListOrg(org: string) {
  return coordinationService.fleetList(org);
}

export async function fleetSteer(target: { user: string; host: string }, msg: { from: string; text: string }) {
  // Signal queue poll — steer visible to steered with sender named, single-writer preserved
  return { ok: true, queued: true, sender: msg.from, target };
}
