// AMICODE SERVICE (#1342, ADR 0027 §2-3/D3+D6): the SWITCH-CONTROL pointer —
// the sole owner of "the currently attached server" for the multiplexing
// amicode_service — plus the THREE-WAY resolver (D3) that consumes it
// alongside Slice 1's keeper bootstrap pointer (keeper_pointer.ts).
//
// ADR 0027 §3/D6: "The 'current attached server' pointer — its state AND its
// local endpoint under /amicode/fleet/*-class routing (never proxied) — is
// owned here and only here. D3 and D4 consume it. A peer's attachment state
// is thus always its own." §D3: "the loopback amicode_service holds N keyed
// upstreams and re-targets by generalizing shouldProxyAmicodeToHost into a
// THREE-way resolver: local honesty surface → local; /amicode/roster → the
// keeper (D7); every other /amicode/* + engine + SSE → the attached server
// named by the D6 pointer. Default: when the pointer is empty (a fresh
// standalone peer), the studio branch routes to the LOCAL engine — the
// attached branch is never undefined."
//
// DI style mirrors keeper_pointer.ts's KeeperPointerDeps EXACTLY: an
// injected path wins, else an env override ($AMICO_FLEET_ATTACHMENT_FILE,
// the sibling of $AMICO_FLEET_KEEPER_FILE / $AMICO_FLEET_ROSTER_FILE), else
// the one shared cache path under ~/.amico/ops/fleet/ — its OWN file, its
// OWN path fragment, its OWN module.
//
// THE ONE SEMANTIC DIFFERENCE FROM THE KEEPER POINTER: an ABSENT keeper
// pointer is an honest MISS (there is always supposed to be exactly one
// keeper, findable). An ABSENT attachment pointer is NOT a miss — it is
// "empty", a meaningful, non-error steady state: a fresh standalone peer
// that has never attached to anyone. `resolveAttachmentPointer` therefore
// returns `{ok:true, attached:false}` for an absent file (never `ok:false`);
// only a PRESENT-but-malformed file is an honest rejection.
//
// This module is Slice 2's full scope (D6, then D3): the pointer (state +
// its own never-proxied endpoint, wired into index.ts's registerFleetRoutes)
// and the pure resolver. WIRING the resolver into server.ts's live
// dispatch() — replacing/augmenting the EXISTING binary
// shouldProxyAmicodeToHost — is Slice 3+'s concern once a real per-attachment
// transport (D9) exists to actually reach the attached server; that existing
// hub/client star-routing method is a byte-unchanged invariant for this
// slice (ADR 0027 §Invariants: "Additive only"). Everything below is
// correct, fully tested, and NOT wired into the live request path.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFileSync } from "./credentials";
import type { KeeperPointer, ResolveKeeperPointerResult } from "./keeper_pointer";

/** The switch-control pointer's on-disk shape: the currently attached
 *  server's reach coordinates. Mirrors KeeperPointer's own vocabulary
 *  (sshAlias + transport, ADR 0026) plus a `machine_id` — the roster's
 *  single-writer key — so a consumer (and a test) can tell this pointer
 *  apart from the keeper's (or another peer's) coordinate without guessing
 *  at address equality. */
export interface AttachmentPointer {
  /** The ssh target the attached server is reachable at. */
  sshAlias: string;
  /** The transport hint (e.g. ssh, tailscale, local). */
  transport: string;
  /** The attached machine's roster machine_id. */
  machine_id: string;
}

export interface AttachmentPointerDeps {
  /** Override the pointer file (pure-injection for tests). Default:
   *  $AMICO_FLEET_ATTACHMENT_FILE → the shared attachment-pointer cache path. */
  attachmentFile?: string;
}

/** The attachment-pointer cache path fragment — a SIBLING of the keeper
 *  pointer's and the roster's caches (all under ~/.amico/ops/fleet/), but
 *  its OWN file. */
export const ATTACHMENT_POINTER_RELPATH = join(".amico", "ops", "fleet", "attachment.json");

/** The attachment-pointer path under a given home (default: the process home). */
export function attachmentPointerPath(home: string = homedir()): string {
  return join(home, ATTACHMENT_POINTER_RELPATH);
}

/** The pointer file this host reads/writes: the injected path, else the
 *  $AMICO_FLEET_ATTACHMENT_FILE override (the test + headless seam), else
 *  the ONE shared cache path every consumer resolves. Mirrors
 *  keeperPointerFilePath's exact precedence. */
export function attachmentPointerFilePath(deps: AttachmentPointerDeps = {}): string {
  if (deps.attachmentFile) return deps.attachmentFile;
  const env = process.env.AMICO_FLEET_ATTACHMENT_FILE;
  if (env && env.trim() !== "") return env;
  return attachmentPointerPath();
}

/** The resolved read. UNLIKE resolveKeeperPointer, an ABSENT file is NOT an
 *  error — `{ok:true, attached:false}` is D3's empty/local default (a fresh
 *  standalone peer is never undefined, never a failure state). A file that
 *  IS present but malformed (missing/blank field) is an honest rejection —
 *  never silently coerced, never a throw. */
export type ResolveAttachmentPointerResult =
  | { ok: true; attached: true; pointer: AttachmentPointer }
  | { ok: true; attached: false }
  | { ok: false; error: string };

/** Resolve the currently-attached server's coordinate from its OWN source.
 *  Absent = empty (D3's local default, not a miss). Present-but-malformed =
 *  an honest rejection. */
export function resolveAttachmentPointer(deps: AttachmentPointerDeps = {}): ResolveAttachmentPointerResult {
  const file = attachmentPointerFilePath(deps);
  if (!existsSync(file)) {
    return { ok: true, attached: false }; // D3: empty = local, never an error
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { ok: false, error: "attachment_pointer_malformed: not valid JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "attachment_pointer_malformed: not a JSON object" };
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o.sshAlias !== "string" || o.sshAlias.trim() === "") {
    return { ok: false, error: `attachment_pointer_malformed: "sshAlias" must be a non-empty string` };
  }
  if (typeof o.transport !== "string" || o.transport.trim() === "") {
    return { ok: false, error: `attachment_pointer_malformed: "transport" must be a non-empty string` };
  }
  if (typeof o.machine_id !== "string" || o.machine_id.trim() === "") {
    return { ok: false, error: `attachment_pointer_malformed: "machine_id" must be a non-empty string` };
  }
  return {
    ok: true,
    attached: true,
    pointer: { sshAlias: o.sshAlias, transport: o.transport, machine_id: o.machine_id },
  };
}

/** Write the attachment pointer (the D5 attach action's future write path —
 *  this slice ships the writer as the pointer's own primitive; a
 *  first-class attach VERB that also drives the roster candidate list is
 *  Slice 4's job). Atomic tmp+rename, the same discipline as the keeper and
 *  roster writers. */
export function writeAttachmentPointerFile(pointer: AttachmentPointer, deps: AttachmentPointerDeps = {}): void {
  const file = attachmentPointerFilePath(deps);
  atomicWriteFileSync(file, JSON.stringify(pointer, null, 2) + "\n");
}

/** Clear the attachment pointer — back to "empty" (D3's local default).
 *  Absent is an idempotent no-op. Slice 4's detach action is this write
 *  PLUS resetting the SSE cursor (D4) — the cursor reset is out of scope
 *  here. */
export function clearAttachmentPointerFile(deps: AttachmentPointerDeps = {}): void {
  rmSync(attachmentPointerFilePath(deps), { force: true });
}

/** GET /amicode/fleet/attachment — the pointer's own local honesty surface
 *  (AC3: never proxied). Mirrors roster.ts's *ReadResponse style: a JSON
 *  string, one success shape, never a throw. A malformed on-disk pointer
 *  degrades to the honest empty shape plus a `error` field — never a
 *  fabricated coordinate, never a crash. */
export function attachmentStatusResponse(deps: AttachmentPointerDeps = {}): string {
  const result = resolveAttachmentPointer(deps);
  if (!result.ok) {
    return JSON.stringify({ ok: true, attached: false, pointer: null, error: result.error });
  }
  return JSON.stringify({
    ok: true,
    attached: result.attached,
    pointer: result.attached ? result.pointer : null,
  });
}

// ── the D3 three-way resolver ────────────────────────────────────────────────

export type MultiplexTarget = "local" | "keeper" | "attached";

export interface ResolvedAmicodeTarget {
  target: MultiplexTarget;
  /** The pointer the decision names, when one applies (absent for "local",
   *  which by definition needs no remote coordinate; absent for "keeper"
   *  when the keeper itself does not currently resolve). */
  pointer?: KeeperPointer | AttachmentPointer;
}

/** D3 — generalizes the EXISTING binary `shouldProxyAmicodeToHost`
 *  (server.ts:242, ADR 0025's hub/client star routing — untouched by this
 *  slice) into a THREE-way decision, driven by this module's D6 attachment
 *  pointer plus Slice 1's D7 keeper pointer (keeper_pointer.ts). PURE: takes
 *  already-resolved pointer results, performs NO I/O and NO network call of
 *  its own. A "resolves to" routing-TARGET decision (AC1-AC4) — never an
 *  "arrives at" proof; real reachability over a transport is Slice 3's job.
 *
 *  Decision table, checked in this order:
 *   1. `/amicode/fleet` or `/amicode/fleet/*` (the local honesty surface,
 *      INCLUDING this pointer's own `/amicode/fleet/attachment` endpoint) →
 *      "local", ALWAYS — never proxied, regardless of attachment (AC3:
 *      `honesty_surface_stays_local`).
 *   2. `/amicode/roster` (exact) or a subpath → "keeper", ALWAYS — even when
 *      an attachment IS set (AC1: `roster_route_resolves_to_distinct_keeper`).
 *      Carries the keeper's pointer when the keeper itself resolves; the
 *      target stays "keeper" even if it does not (D7's registry role is a
 *      structural fact about the path, independent of live reachability).
 *   3. everything else — every OTHER `/amicode/*` path, the raw engine data
 *      plane, and SSE — → "attached" when the attachment pointer resolves to
 *      a set coordinate (AC2: `studio_state_resolves_to_attached_server`),
 *      else "local" — the empty-or-malformed-pointer default (AC4:
 *      `empty_attachment_routes_local`). The attached branch is thus never
 *      undefined: absent, empty, or corrupt all fail safe to local. */
export function resolveAmicodeTarget(
  pathname: string,
  opts: { attached: ResolveAttachmentPointerResult; keeper: ResolveKeeperPointerResult },
): ResolvedAmicodeTarget {
  if (pathname === "/amicode/fleet" || pathname.startsWith("/amicode/fleet/")) {
    return { target: "local" };
  }
  if (pathname === "/amicode/roster" || pathname.startsWith("/amicode/roster/")) {
    return opts.keeper.ok ? { target: "keeper", pointer: opts.keeper.pointer } : { target: "keeper" };
  }
  if (opts.attached.ok && opts.attached.attached) {
    return { target: "attached", pointer: opts.attached.pointer };
  }
  return { target: "local" };
}
