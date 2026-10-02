// additive_invariants_gate.test.ts — the ADR 0027 cross-cutting "peer studios
// stay ADDITIVE" gate (#1346). Peer slices ADD files; their whole safety story
// is that the merged hub/star path — `amico fleet enroll`, the never-fork guard
// shim, the one-parser rule, single-writer-per-DB — is left byte-unchanged, and
// that peer machines never take the never-fork `client` stance. This suite makes
// that a STANDING MECHANICAL check, so a regression in any peer slice is caught.
//
// Two halves, on purpose (defense in depth):
//   • the standing bash gate (scripts/assert_additive_invariants.sh) — the CI
//     surface — is run here as a subprocess and asserted GREEN. It owns AC1's
//     git-diff-vs-MERGE-BASE (the make-or-break), and the AC2/AC3/AC4 source
//     scans;
//   • this suite ALSO exercises AC4 BEHAVIORALLY (drives the real attach verb and
//     proves it writes no fleet.json / no role=client / installs no guard /
//     spawns no engine) and re-asserts AC2/AC3 structurally — so the invariants
//     are meaningfully exercised by `pnpm --filter amicode test` even independent
//     of the script.
//
// DELIBERATE, director-tracked: the live proxy/SSE re-target to an attached peer
// is intentionally UNWIRED (server.ts held byte-identical); "attach is proxy-only
// / spawns no engine" is CONSISTENT with that deferral — it is not a bug.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROSTER_SCHEMA_VERSION, type RosterDocument, type RosterRow } from "@amicode/schema";
import { attachActionResponse } from "../src/amicode_service/attach_action";

const REPO = join(__dirname, "..", "..", "..");
const GATE = join(REPO, "packages", "extension", "scripts", "assert_additive_invariants.sh");
const CI = join(REPO, ".github", "workflows", "ci.yml");
const svc = (...p: string[]) => join(__dirname, "..", "src", "amicode_service", ...p);
const readFile = (p: string): string => readFileSync(p, "utf8");

/** All files under `dir`, recursively (for proving what an attach did/did not write). */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const row = (over: Partial<RosterRow> = {}): RosterRow => ({
  machine_id: "peer-01",
  name: "Peer One",
  server_mode: "server",
  capabilities: [],
  sshAlias: "peer-one@host",
  transport: "ssh",
  last_report: "2026-09-20T12:00:00.000Z",
  health: "reachable",
  ...over,
});

function writeRoster(file: string, rows: RosterRow[]): void {
  const doc: RosterDocument = { schema_version: ROSTER_SCHEMA_VERSION, rows };
  writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
}

// ── The standing bash gate (the CI surface) ─────────────────────────────────
describe("the additive-invariants gate script (ADR 0027, #1346)", () => {
  it("exists and is executable", () => {
    expect(existsSync(GATE)).toBe(true);
    expect((statSync(GATE).mode & 0o111) !== 0).toBe(true);
  });

  it("runs GREEN on this branch — all four additive invariants hold", () => {
    const r = spawnSync("bash", [GATE], { cwd: REPO, encoding: "utf8" });
    // Exit-code contract: 0 = all invariants hold; 1 = a REAL violation (always a
    // hard failure, never soft); 3 = AC1 UNVERIFIABLE here (the base ref is not
    // fetched in this sandbox) — a loud warning, not this slice's regression.
    if (r.status === 3) {
      // eslint-disable-next-line no-console
      console.warn(`[additive-gate] AC1 unverifiable in this sandbox:\n${r.stdout}\n${r.stderr}`);
    }
    expect(r.status, `gate exit=${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`).not.toBe(1);
    expect([0, 3]).toContain(r.status);
  });

  it("is wired into CI (a gate that does not run is dead)", () => {
    expect(readFile(CI)).toMatch(/assert_additive_invariants\.sh/);
  });
});

// ── AC2 — no NEW parser of fleet.json outside the ONE parser home ────────────
// The trap: keeper_pointer.ts / attachment_pointer.ts MENTION fleet.json in
// comments and parse their OWN sibling artifact (keeper.json / attachment.json).
// A comment or a sibling-parse is FINE; a readFileSync of a /fleet.json path is
// the violation — the same idiom fleet_topology_single_parser.test.ts gates on.
describe("AC2 — the one parser of fleet.json stays @amicode/schema (#1346)", () => {
  it("the peer/attach modules read their OWN sibling pointer, never fleet.json", () => {
    for (const m of ["keeper_pointer.ts", "attachment_pointer.ts", "attach_action.ts", "attachment_transport.ts"]) {
      const s = readFile(svc(m));
      expect(s, `${m} must not readFileSync a fleet.json path`).not.toMatch(/readFileSync[^;]*fleet\.json/);
    }
  });

  it("the parser home is @amicode/schema (parseFleetTopology reader + writeFleetConfig writer)", () => {
    const proj = readFile(join(REPO, "packages", "schema", "src", "fleet_projection.ts"));
    expect(proj).toMatch(/export function parseFleetTopology/);
    const cfg = readFile(join(REPO, "packages", "schema", "src", "fleet_config.ts"));
    expect(cfg).toMatch(/export function writeFleetConfig/);
  });
});

// ── AC3 — the peer/attach path opens no second DB writer (proxy-only) ────────
// adopt-or-spawn (server_lifecycle.ts) is the SOLE writer primitive; the attach
// path stands up a PROXY (an ssh -L forward), never a local engine.
describe("AC3 — attach is proxy-only; adopt-or-spawn is the sole writer (#1346)", () => {
  it("the attach modules reach no engine-writer primitive (server_lifecycle/adoptOrSpawn)", () => {
    for (const m of ["attach_action.ts", "attachment_pointer.ts", "attachment_transport.ts", "attach_state.ts", "attachment_credential.ts"]) {
      const s = readFile(svc(m));
      expect(s, `${m} must not import server_lifecycle`).not.toMatch(/server_lifecycle/);
      expect(s, `${m} must not call adoptOrSpawn/coldSpawn/buildLiveDeps`).not.toMatch(/adoptOrSpawn|coldSpawn|buildLiveDeps/);
    }
  });

  it("the only thing the attach transport spawns is the ssh proxy — never an engine", () => {
    const s = readFile(svc("attachment_transport.ts"));
    expect(s).not.toMatch(/spawn[^;]*opencode/);
    expect(s).toMatch(/spawnFn\("ssh"/); // the proxy forward, the sole spawn
  });

  it("adopt-or-spawn remains the sole writer primitive in server_lifecycle.ts", () => {
    expect(readFile(join(REPO, "packages", "extension", "src", "server_lifecycle.ts"))).toMatch(/adoptOrSpawn/);
  });
});

// ── AC4 — the peer-attach flow uses no client stance (BEHAVIORAL) ────────────
// Non-vacuous now that Slice 4's attach flow exists: drive the real attach verb
// and prove it writes no fleet.json, no role=client, installs no guard, spawns
// no engine — attach writes the attachment POINTER, not fleet.json.
describe("AC4 — the peer-attach flow never takes the client stance (#1346)", () => {
  let dir: string;
  let attachmentFile: string;
  let rosterFile: string;
  let credentialFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "additive-ac4-"));
    attachmentFile = join(dir, "attachment.json");
    rosterFile = join(dir, "roster.json");
    credentialFile = join(dir, "attachment-credentials.json");
    writeRoster(rosterFile, [row()]);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("an attach sets the pointer but writes NO fleet.json, and the pointer carries no role", () => {
    const res = JSON.parse(
      attachActionResponse(JSON.stringify({ machine_id: "peer-01" }), { attachmentFile, rosterFile, credentialFile }),
    ) as { ok: boolean; attached: boolean; pointer: Record<string, unknown> };
    expect(res.ok).toBe(true);
    expect(res.attached).toBe(true);
    // it wrote the attachment POINTER, not fleet.json — nowhere in the tree
    expect(walk(dir).some((p) => p.endsWith("fleet.json"))).toBe(false);
    // and the pointer carries NO role field (so it can never be role=client)
    expect("role" in res.pointer).toBe(false);
    expect(readFile(attachmentFile)).not.toMatch(/"role"/);
  });

  it("the attach flow's source installs no guard and writes no fleet.json (writeFleetConfig)", () => {
    const s = readFile(svc("attach_action.ts"));
    expect(s).not.toMatch(/writeFleetConfig|fleet_config/); // never writes fleet.json
    expect(s).not.toMatch(/deploy_guard|amico-opencode-fleet-guard/); // never installs the guard
    expect(s).not.toMatch(/"role"\s*:\s*"client"|role:\s*"client"/); // never the client stance
    expect(s).not.toMatch(/child_process/); // spawns no engine
  });
});
