// ATTACH/DETACH ACTION (#1344, ADR 0027 §3/D5 — Slice 4): the FIRST-CLASS verb
// that INVOKES a switch. Slices 2-3 shipped the pieces — the D6 switch-control
// pointer (attachment_pointer.ts), the D3 three-way resolver, the per-attachment
// real transport (attachment_transport.ts) and the per-attachment credential
// store (attachment_credential.ts) — but NOTHING drove them: no surface added an
// upstream or flipped the pointer. This module is that surface's LOGIC.
//
// The contract (ADR 0027 §3, this slice's AC1):
//   attach  — adds an upstream and SETS the pointer. The ROSTER is the sole
//             candidate source: you may only attach to a machine the roster
//             knows (its row supplies the pointer's reach coordinates —
//             sshAlias/transport — so the caller cannot forge a coordinate).
//             Optional {base_url, token} PROVISIONS the per-attachment credential
//             (D10a); omit them for the honest uncredentialed leg.
//   detach  — REMOVES the upstream: clears the pointer (back to the empty/local
//             default) and the credential.
//
// A SWITCH is a pointer flip to a DIFFERENT server. On a switch — and on a detach
// that leaves an attached server — the SSE cursor is meaningless (a different
// server's aggregate seqs are not ours), so the verb invokes the injected
// `resetCursorOnSwitch` seam. That reset is what makes the multiplexer's NEXT
// per-session subscription open a FRESH stream with no `?after=` (AC3). The seam
// is injected (not reached for here) because the cursor store lives with the
// staged fleet plane; a standalone peer that has no multiplexer simply passes no
// callback, and the pointer still flips — the verb is reachable on a standalone
// boot regardless (the route-registration fix in index.ts).
//
// Every failure collapses into the sibling {ok:false, error:"code: detail"}
// shape — never a throw, never a half-write, and (roster.ts's discipline) never
// echoes the caller's bytes back.
import { existsSync, readFileSync } from "node:fs";
import { emptyRoster, parseRosterDocument, type RosterRow } from "@amicode/schema";
import {
  clearAttachmentPointerFile,
  resolveAttachmentPointer,
  writeAttachmentPointerFile,
  type AttachmentPointer,
  type AttachmentPointerDeps,
} from "./attachment_pointer";
import { rosterFilePath, type RosterDeps } from "./roster";
import {
  clearAttachmentCredential,
  writeAttachmentCredential,
  type AttachmentCredentialDeps,
} from "./attachment_credential";

export interface AttachActionDeps extends AttachmentPointerDeps, RosterDeps, AttachmentCredentialDeps {
  /** The SWITCH side-effect seam (AC3): invoked when the attached origin
   *  actually CHANGES (attach to a different peer, or detach from an attached
   *  one) so the multiplexer's next per-session SSE subscription opens a fresh
   *  stream with no `?after=`. Injected because the cursor store lives with the
   *  staged fleet plane; a standalone peer passes nothing and the pointer still
   *  flips. */
  resetCursorOnSwitch?: () => void;
}

/** Tolerant roster load → the fleet-wide rows (the candidate source). An absent
 *  or malformed store reads as the empty roster — a candidate lookup then finds
 *  nothing and the attach is honestly refused, never a throw. Reuses the SAME
 *  path resolver (rosterFilePath) + schema parser the roster route uses. */
function loadRosterRows(deps: AttachActionDeps): RosterRow[] {
  const file = rosterFilePath(deps);
  if (!existsSync(file)) return emptyRoster().rows;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return emptyRoster().rows;
  }
  const doc = parseRosterDocument(parsed);
  return doc.ok ? doc.doc.rows : emptyRoster().rows;
}

/** Fixed-string refusal — sibling discipline, never echoes the caller's bytes. */
function refuse(code: string, detail: string): string {
  return JSON.stringify({ ok: false, attached: false, pointer: null, error: `${code}: ${detail}` });
}

interface AttachBody {
  machine_id: string;
  base_url?: string;
  token?: string;
}

function parseAttachBody(rawBody: string): AttachBody | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const o = parsed as Record<string, unknown>;
  if (typeof o.machine_id !== "string" || o.machine_id.trim() === "") return undefined;
  const out: AttachBody = { machine_id: o.machine_id };
  if (typeof o.base_url === "string" && o.base_url.trim() !== "") out.base_url = o.base_url;
  if (typeof o.token === "string" && o.token.trim() !== "") out.token = o.token;
  return out;
}

/** The currently-attached machine_id, or null when empty/malformed (both are
 *  "not attached to this" for the switch decision). */
function currentMachineId(deps: AttachActionDeps): string | null {
  const r = resolveAttachmentPointer(deps);
  return r.ok && r.attached ? r.pointer.machine_id : null;
}

/** POST /amicode/fleet/attach — add an upstream + set the pointer from the
 *  matching roster row (candidate source). Optional {base_url, token} provisions
 *  the per-attachment credential. Resets the SSE cursor when the attached origin
 *  changes (a switch). */
export function attachActionResponse(rawBody: string, deps: AttachActionDeps = {}): string {
  const body = parseAttachBody(rawBody);
  if (!body) return refuse("bad_request", "body must be a JSON object with a non-empty machine_id");

  const rows = loadRosterRows(deps);
  const match = rows.find((r) => r.machine_id === body.machine_id);
  // The ROSTER is the sole candidate source: no row → no attach (a refused
  // attach never half-writes a pointer or a credential).
  if (!match) return refuse("unknown_machine", "the requested machine_id is not in the fleet roster");

  const prior = currentMachineId(deps);
  const pointer: AttachmentPointer = {
    sshAlias: match.sshAlias,
    transport: match.transport,
    machine_id: match.machine_id,
  };
  writeAttachmentPointerFile(pointer, deps);
  if (body.base_url && body.token) {
    writeAttachmentCredential(match.machine_id, { baseUrl: body.base_url, token: body.token }, deps);
  }

  const switched = prior !== match.machine_id;
  if (switched) deps.resetCursorOnSwitch?.();

  return JSON.stringify({ ok: true, attached: true, pointer, switched });
}

/** POST /amicode/fleet/detach — remove the upstream: clear the pointer (back to
 *  the empty/local default) and the credential. An already-empty detach is an
 *  idempotent no-op. Resets the SSE cursor when it actually left an attached
 *  server. The body's optional machine_id names the credential to clear; absent,
 *  the currently-attached one is used. */
export function detachActionResponse(rawBody: string, deps: AttachActionDeps = {}): string {
  const prior = currentMachineId(deps);
  let bodyMachineId: string | undefined;
  if (rawBody && rawBody.trim() !== "") {
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const mid = (parsed as Record<string, unknown>).machine_id;
        if (typeof mid === "string" && mid.trim() !== "") bodyMachineId = mid;
      }
    } catch {
      /* a malformed detach body is tolerated — detach is idempotent by design */
    }
  }

  clearAttachmentPointerFile(deps);
  const credMachineId = bodyMachineId ?? prior ?? undefined;
  if (credMachineId) clearAttachmentCredential(credMachineId, deps);

  const switched = prior !== null; // leaving an attached server invalidates its cursors
  if (switched) deps.resetCursorOnSwitch?.();

  return JSON.stringify({ ok: true, attached: false, switched });
}
