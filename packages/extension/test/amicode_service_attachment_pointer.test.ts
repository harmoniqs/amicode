// amicode-service switch-control (attachment) pointer + three-way resolver
// tests (#1342, ADR 0027 §2-3/D3+D6). Slice 1 (#1341) shipped the KEEPER
// bootstrap pointer (resolveKeeperPointer); this slice ships its SIBLING —
// the "currently attached server" pointer — plus the D3 resolver that
// generalizes the existing BINARY shouldProxyAmicodeToHost into a THREE-way
// decision: the local honesty surface → local; /amicode/roster → the
// keeper (regardless of attachment); everything else (/amicode/* + the raw
// engine data plane + SSE) → the attached server, or local when the
// attachment pointer is empty (D3's fresh-standalone-peer default).
//
// UNLIKE the keeper pointer (whose absence is an honest miss — there is
// always exactly one keeper), an ABSENT attachment pointer is a MEANINGFUL
// non-error state: "empty" = local. That is the whole point of
// `empty_attachment_routes_local`.
//
// These are ROUTING-TARGET assertions ("resolves to"), never "reaches" —
// end-to-end reachability over a real transport is Slice 3's job. The
// resolver here is a PURE function over already-resolved pointer results:
// no I/O, no network call, so a routing decision can be asserted without
// ever touching a socket.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveAttachmentPointer,
  attachmentPointerFilePath,
  writeAttachmentPointerFile,
  clearAttachmentPointerFile,
  attachmentStatusResponse,
  resolveAmicodeTarget,
  ATTACHMENT_POINTER_RELPATH,
  type AttachmentPointer,
} from "../src/amicode_service/attachment_pointer";
import { writeKeeperPointerFile, type KeeperPointer, type ResolveKeeperPointerResult } from "../src/amicode_service/keeper_pointer";
import { resolveKeeperPointer } from "../src/amicode_service/keeper_pointer";

const ATTACHED: AttachmentPointer = { sshAlias: "attached-host", transport: "ssh", machine_id: "mac-attached-01" };
const KEEPER: KeeperPointer = { sshAlias: "keeper-host", transport: "ssh" };

describe("resolveAttachmentPointer — the D6 switch-control pointer (#1342)", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "attach-ptr-"));
    file = join(dir, "attachment.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("resolves a written pointer from an injected file path, verbatim", () => {
    writeAttachmentPointerFile(ATTACHED, { attachmentFile: file });
    const result = resolveAttachmentPointer({ attachmentFile: file });
    expect(result).toEqual({ ok: true, attached: true, pointer: ATTACHED });
  });

  it("an ABSENT pointer file is 'empty' — ok:true, attached:false — NEVER an error (D3's local default, unlike the keeper's honest miss)", () => {
    expect(existsSync(file)).toBe(false);
    const result = resolveAttachmentPointer({ attachmentFile: file });
    expect(result).toEqual({ ok: true, attached: false });
  });

  it("a malformed pointer file (missing sshAlias) is rejected, never coerced", () => {
    writeFileSync(file, JSON.stringify({ transport: "ssh", machine_id: "x" }));
    const result = resolveAttachmentPointer({ attachmentFile: file });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.error).toMatch(/sshAlias/);
  });

  it("a malformed pointer file (missing machine_id) is rejected — the field KeeperPointer does not carry", () => {
    writeFileSync(file, JSON.stringify({ sshAlias: "x", transport: "ssh" }));
    const result = resolveAttachmentPointer({ attachmentFile: file });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.error).toMatch(/machine_id/);
  });

  it("a non-JSON pointer file is rejected, never a throw", () => {
    writeFileSync(file, "not json at all {{{");
    expect(() => resolveAttachmentPointer({ attachmentFile: file })).not.toThrow();
    const result = resolveAttachmentPointer({ attachmentFile: file });
    expect(result.ok).toBe(false);
  });

  it("respects $AMICO_FLEET_ATTACHMENT_FILE when no path is injected (the env seam, sibling to AMICO_FLEET_KEEPER_FILE / AMICO_FLEET_ROSTER_FILE)", () => {
    const saved = process.env.AMICO_FLEET_ATTACHMENT_FILE;
    process.env.AMICO_FLEET_ATTACHMENT_FILE = file;
    try {
      writeAttachmentPointerFile(ATTACHED, {});
      expect(attachmentPointerFilePath({})).toBe(file);
      expect(resolveAttachmentPointer({})).toEqual({ ok: true, attached: true, pointer: ATTACHED });
    } finally {
      if (saved === undefined) delete process.env.AMICO_FLEET_ATTACHMENT_FILE;
      else process.env.AMICO_FLEET_ATTACHMENT_FILE = saved;
    }
  });

  it("an injected path takes precedence over the env override (mirrors keeperPointerFilePath's own precedence)", () => {
    const envFile = join(dir, "env-attachment.json");
    writeFileSync(envFile, JSON.stringify({ sshAlias: "wrong-one", transport: "ssh", machine_id: "wrong" }));
    const saved = process.env.AMICO_FLEET_ATTACHMENT_FILE;
    process.env.AMICO_FLEET_ATTACHMENT_FILE = envFile;
    try {
      writeAttachmentPointerFile(ATTACHED, { attachmentFile: file });
      expect(resolveAttachmentPointer({ attachmentFile: file })).toEqual({ ok: true, attached: true, pointer: ATTACHED });
    } finally {
      if (saved === undefined) delete process.env.AMICO_FLEET_ATTACHMENT_FILE;
      else process.env.AMICO_FLEET_ATTACHMENT_FILE = saved;
    }
  });

  it("clearAttachmentPointerFile restores the empty/local default (Slice 4's future detach primitive)", () => {
    writeAttachmentPointerFile(ATTACHED, { attachmentFile: file });
    expect(resolveAttachmentPointer({ attachmentFile: file }).ok).toBe(true);
    clearAttachmentPointerFile({ attachmentFile: file });
    expect(existsSync(file)).toBe(false);
    expect(resolveAttachmentPointer({ attachmentFile: file })).toEqual({ ok: true, attached: false });
  });

  it("clearAttachmentPointerFile on an already-absent file is an idempotent no-op", () => {
    expect(existsSync(file)).toBe(false);
    expect(() => clearAttachmentPointerFile({ attachmentFile: file })).not.toThrow();
    expect(existsSync(file)).toBe(false);
  });

  it("the attachment-pointer cache path is its OWN relpath, distinct from the keeper's and the roster's", () => {
    expect(ATTACHMENT_POINTER_RELPATH).not.toMatch(/keeper\.json$/);
    expect(ATTACHMENT_POINTER_RELPATH).not.toMatch(/roster\.json$/);
    expect(ATTACHMENT_POINTER_RELPATH).not.toMatch(/fleet\.json$/);
  });
});

describe("attachmentStatusResponse — the /amicode/fleet/attachment local honesty surface (#1342)", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "attach-status-"));
    file = join(dir, "attachment.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reports attached:false, pointer:null when empty", () => {
    const body = JSON.parse(attachmentStatusResponse({ attachmentFile: file })) as {
      ok: boolean;
      attached: boolean;
      pointer: unknown;
    };
    expect(body).toEqual({ ok: true, attached: false, pointer: null });
  });

  it("reports the pointer verbatim when attached", () => {
    writeAttachmentPointerFile(ATTACHED, { attachmentFile: file });
    const body = JSON.parse(attachmentStatusResponse({ attachmentFile: file })) as {
      ok: boolean;
      attached: boolean;
      pointer: AttachmentPointer;
    };
    expect(body).toEqual({ ok: true, attached: true, pointer: ATTACHED });
  });

  it("a malformed file degrades to the honest empty shape plus an error — never a throw, never a fabricated pointer", () => {
    writeFileSync(file, "{{{ not json");
    expect(() => attachmentStatusResponse({ attachmentFile: file })).not.toThrow();
    const body = JSON.parse(attachmentStatusResponse({ attachmentFile: file })) as {
      ok: boolean;
      attached: boolean;
      pointer: unknown;
      error?: string;
    };
    expect(body.attached).toBe(false);
    expect(body.pointer).toBeNull();
    expect(body.error).toBeTruthy();
  });
});

describe("resolveAmicodeTarget — the D3 three-way resolver (#1342, ADR 0027 §3)", () => {
  const KEEPER_OK: ResolveKeeperPointerResult = { ok: true, pointer: KEEPER };
  const ATTACHED_OK = { ok: true as const, attached: true as const, pointer: ATTACHED };
  const ATTACHED_EMPTY = { ok: true as const, attached: false as const };

  it("roster_route_resolves_to_distinct_keeper == 1 — GET/POST /amicode/roster resolves to the KEEPER, never the attached peer, regardless of attachment", () => {
    const withAttachment = resolveAmicodeTarget("/amicode/roster", { attached: ATTACHED_OK, keeper: KEEPER_OK });
    const withoutAttachment = resolveAmicodeTarget("/amicode/roster", { attached: ATTACHED_EMPTY, keeper: KEEPER_OK });
    expect(withAttachment).toEqual({ target: "keeper", pointer: KEEPER });
    expect(withoutAttachment).toEqual({ target: "keeper", pointer: KEEPER });
    // the keeper's pointer is DISTINCT from the attached one — proves this
    // did not accidentally fall through to the attached branch
    expect((withAttachment.pointer as KeeperPointer).sshAlias).not.toBe(ATTACHED.sshAlias);
  });

  it("roster_route_resolves_to_distinct_keeper == 1 — a /amicode/roster subpath resolves the same way", () => {
    const decision = resolveAmicodeTarget("/amicode/roster/anything", { attached: ATTACHED_OK, keeper: KEEPER_OK });
    expect(decision.target).toBe("keeper");
  });

  it("studio_state_resolves_to_attached_server == 1 — every OTHER /amicode/* path resolves to the ATTACHED server, not the keeper", () => {
    for (const p of ["/amicode/vaults", "/amicode/profile", "/amicode/problems", "/amicode/connections"]) {
      const decision = resolveAmicodeTarget(p, { attached: ATTACHED_OK, keeper: KEEPER_OK });
      expect(decision).toEqual({ target: "attached", pointer: ATTACHED });
    }
  });

  it("studio_state_resolves_to_attached_server == 1 — the raw engine data plane (non-/amicode paths) resolves to the ATTACHED server", () => {
    for (const p of ["/session", "/global/health", "/config"]) {
      const decision = resolveAmicodeTarget(p, { attached: ATTACHED_OK, keeper: KEEPER_OK });
      expect(decision).toEqual({ target: "attached", pointer: ATTACHED });
    }
  });

  it("studio_state_resolves_to_attached_server == 1 — an SSE-shaped path (per-session event stream) resolves to the ATTACHED server", () => {
    const decision = resolveAmicodeTarget("/api/session/ses-1/event", { attached: ATTACHED_OK, keeper: KEEPER_OK });
    expect(decision).toEqual({ target: "attached", pointer: ATTACHED });
  });

  it("honesty_surface_stays_local == 1 — /amicode/fleet (exact) always resolves local, even with an attachment AND a keeper set", () => {
    const decision = resolveAmicodeTarget("/amicode/fleet", { attached: ATTACHED_OK, keeper: KEEPER_OK });
    expect(decision).toEqual({ target: "local" });
  });

  it("honesty_surface_stays_local == 1 — /amicode/fleet/status stays local, never proxied", () => {
    const decision = resolveAmicodeTarget("/amicode/fleet/status", { attached: ATTACHED_OK, keeper: KEEPER_OK });
    expect(decision).toEqual({ target: "local" });
  });

  it("honesty_surface_stays_local == 1 — the switch-pointer's OWN endpoint (/amicode/fleet/attachment) stays local, never proxied", () => {
    const decision = resolveAmicodeTarget("/amicode/fleet/attachment", { attached: ATTACHED_OK, keeper: KEEPER_OK });
    expect(decision).toEqual({ target: "local" });
  });

  it("honesty_surface_stays_local == 1 — the local branch wins even with NO keeper resolvable (never crashes, never falls elsewhere)", () => {
    const decision = resolveAmicodeTarget("/amicode/fleet/status", {
      attached: ATTACHED_OK,
      keeper: { ok: false, error: "keeper_pointer_absent: no bootstrap pointer" },
    });
    expect(decision).toEqual({ target: "local" });
  });

  it("empty_attachment_routes_local == 1 — with the attachment pointer EMPTY, studio /amicode/* resolves to LOCAL (the D3 default branch)", () => {
    for (const p of ["/amicode/vaults", "/amicode/profile"]) {
      const decision = resolveAmicodeTarget(p, { attached: ATTACHED_EMPTY, keeper: KEEPER_OK });
      expect(decision).toEqual({ target: "local" });
    }
  });

  it("empty_attachment_routes_local == 1 — with the attachment pointer EMPTY, the engine + SSE paths resolve to LOCAL", () => {
    for (const p of ["/session", "/api/session/ses-1/event"]) {
      const decision = resolveAmicodeTarget(p, { attached: ATTACHED_EMPTY, keeper: KEEPER_OK });
      expect(decision).toEqual({ target: "local" });
    }
  });

  it("empty_attachment_routes_local == 1 — the attached branch is NEVER undefined: a malformed attachment pointer ALSO fails safe to local", () => {
    const decision = resolveAmicodeTarget("/amicode/vaults", {
      attached: { ok: false, error: "attachment_pointer_malformed: not valid JSON" },
      keeper: KEEPER_OK,
    });
    expect(decision).toEqual({ target: "local" });
  });

  it("roster resolution is METHOD-agnostic — GET and POST alike resolve the same pathname to the keeper (the resolver decides on pathname, not verb)", () => {
    // resolveAmicodeTarget takes only a pathname by design (D3's decision
    // table is path-keyed); this pins that a caller cannot accidentally
    // route GET /amicode/roster to the keeper and POST /amicode/roster
    // elsewhere.
    const get = resolveAmicodeTarget("/amicode/roster", { attached: ATTACHED_OK, keeper: KEEPER_OK });
    const post = resolveAmicodeTarget("/amicode/roster", { attached: ATTACHED_OK, keeper: KEEPER_OK });
    expect(get).toEqual(post);
    expect(get.target).toBe("keeper");
  });
});

// Sanity: writeKeeperPointerFile / resolveKeeperPointer (Slice 1) are reused
// verbatim by the resolver's callers — imported here only to prove the two
// pointer modules compose without friction (no re-implementation).
describe("keeper + attachment pointers compose (Slice 1 x Slice 2, #1342)", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a keeper pointer and an attachment pointer can coexist at distinct files with distinct coordinates", () => {
    dir = mkdtempSync(join(tmpdir(), "compose-"));
    const keeperFile = join(dir, "keeper.json");
    const attachmentFile = join(dir, "attachment.json");
    writeKeeperPointerFile(KEEPER, { keeperFile });
    writeAttachmentPointerFile(ATTACHED, { attachmentFile });
    const keeper = resolveKeeperPointer({ keeperFile });
    const attached = resolveAttachmentPointer({ attachmentFile });
    expect(keeper).toEqual({ ok: true, pointer: KEEPER });
    expect(attached).toEqual({ ok: true, attached: true, pointer: ATTACHED });
  });
});
