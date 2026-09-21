// AMICODE SERVICE (#1341, ADR 0027 §4/D7): the directory-KEEPER bootstrap
// pointer — a resolvable coordinate for "reach the keeper" that is carried by
// its OWN small file, deliberately NEVER derived from roster.json. Finding
// the keeper via the very roster it hosts would be circular (ADR 0027 §4: "the
// keeper's coordinate is carried by an explicit keeper bootstrap pointer …
// NOT discovered from the very roster.json the keeper hosts"). This is a NEW,
// first-class resolvable coordinate — a sibling of the future D6 switch-
// control pointer (the "currently attached server" pointer, Slice 2) — but it
// names the KEEPER (the registry role), never "the only server".
//
// Slice 1 (this module) ships the coordinate + its resolver only. Slice 2 is
// where a consumer (the three-way resolver, D3) reads it to route
// /amicode/roster at the keeper regardless of attachment
// (`roster_route_resolves_to_distinct_keeper`).
//
// DI style mirrors roster.ts's RosterDeps exactly: an injected path wins, else
// an env override ($AMICO_FLEET_KEEPER_FILE, the sibling of
// $AMICO_FLEET_ROSTER_FILE), else the one shared cache path. Deliberately its
// own file, its own path fragment, its own module — no import of the roster
// contract (@amicode/schema's fleet_roster) anywhere below, so "resolves the
// keeper" can never be circular even by accident.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFileSync } from "./credentials";

/** The keeper bootstrap pointer's on-disk shape: a resolvable reach
 *  coordinate for the directory keeper. Mirrors RosterRow's own reach
 *  vocabulary (sshAlias + transport, ADR 0026) rather than inventing a new
 *  one — but this is NOT a roster row, and is never read from one. */
export interface KeeperPointer {
  /** The ssh target the keeper is reachable at (its fleet.json canonical alias). */
  sshAlias: string;
  /** The transport hint (e.g. ssh, tailscale, local). */
  transport: string;
}

export interface KeeperPointerDeps {
  /** Override the pointer file (pure-injection for tests). Default:
   *  $AMICO_FLEET_KEEPER_FILE → the shared keeper-pointer cache path. */
  keeperFile?: string;
}

/** The keeper-pointer cache path fragment — a SIBLING of the roster cache and
 *  the fleet.json topology path (all under ~/.amico/ops/fleet/), but its OWN
 *  file. Resolving the keeper must never read roster.json (circular) or
 *  fleet.json (ADR 0023's one-parser invariant: nothing here parses it). */
export const KEEPER_POINTER_RELPATH = join(".amico", "ops", "fleet", "keeper.json");

/** The keeper-pointer path under a given home (default: the process home). */
export function keeperPointerPath(home: string = homedir()): string {
  return join(home, KEEPER_POINTER_RELPATH);
}

/** The pointer file this host reads/writes: the injected path, else the
 *  $AMICO_FLEET_KEEPER_FILE override (the test + headless seam), else the ONE
 *  shared cache path every consumer resolves. Mirrors rosterFilePath's exact
 *  precedence (roster.ts) — injected path first, then env, then the default. */
export function keeperPointerFilePath(deps: KeeperPointerDeps = {}): string {
  if (deps.keeperFile) return deps.keeperFile;
  const env = process.env.AMICO_FLEET_KEEPER_FILE;
  if (env && env.trim() !== "") return env;
  return keeperPointerPath();
}

export type ResolveKeeperPointerResult = { ok: true; pointer: KeeperPointer } | { ok: false; error: string };

/** Resolve the keeper's bootstrap coordinate from its OWN source — never from
 *  roster.json (which would be circular: the keeper is the machine that
 *  HOSTS that file). An absent or malformed pointer file is an honest miss,
 *  a Result never a throw, and never a silently fabricated address. */
export function resolveKeeperPointer(deps: KeeperPointerDeps = {}): ResolveKeeperPointerResult {
  const file = keeperPointerFilePath(deps);
  if (!existsSync(file)) {
    return { ok: false, error: `keeper_pointer_absent: no bootstrap pointer at ${file}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { ok: false, error: "keeper_pointer_malformed: not valid JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "keeper_pointer_malformed: not a JSON object" };
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o.sshAlias !== "string" || o.sshAlias.trim() === "") {
    return { ok: false, error: `keeper_pointer_malformed: "sshAlias" must be a non-empty string` };
  }
  if (typeof o.transport !== "string" || o.transport.trim() === "") {
    return { ok: false, error: `keeper_pointer_malformed: "transport" must be a non-empty string` };
  }
  return { ok: true, pointer: { sshAlias: o.sshAlias, transport: o.transport } };
}

/** Write the keeper bootstrap pointer (the bootstrap/ops act of naming the
 *  keeper — not a self-report; there is exactly one keeper coordinate, not a
 *  per-machine row). Atomic tmp+rename, the same discipline as the roster
 *  self-report writer. */
export function writeKeeperPointerFile(pointer: KeeperPointer, deps: KeeperPointerDeps = {}): void {
  const file = keeperPointerFilePath(deps);
  atomicWriteFileSync(file, JSON.stringify(pointer, null, 2) + "\n");
}
