// amicode-service attach/detach ACTION verb tests (#1344, ADR 0027 §3, Slice 4).
// Slices 2-3 shipped the D6 pointer, the D3 resolver, the per-attachment real
// transport, and the per-attachment credential store — but NOTHING invoked a
// switch or populated an attachment. This slice adds the attach/detach ACTION:
// attach adds an upstream and sets the pointer; detach removes it and clears the
// pointer; the ROSTER is the candidate source (you can only attach to a machine
// the roster knows). A switch (a pointer flip to a DIFFERENT server) resets the
// SSE cursor — a different server's seqs are meaningless.
//
// These pin the verb's PURE logic (over injected file paths + an injected
// switch callback, the same DI seams the pointer/credential modules already
// carry). The route-reachable-on-a-standalone-boot proof (the open design gap
// this slice OWNS — the pointer routes were gated behind the fleet entitlement)
// is the live-boot group at the bottom.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ROSTER_SCHEMA_VERSION,
  type RosterDocument,
  type RosterRow,
} from "@amicode/schema";
import { attachActionResponse, detachActionResponse } from "../src/amicode_service/attach_action";
import { resolveAttachmentPointer } from "../src/amicode_service/attachment_pointer";
import { readAttachmentCredential } from "../src/amicode_service/attachment_credential";
import { SessionEventResume } from "../src/amicode_service/session_event_resume";
import { createAmicodeService } from "../src/amicode_service";
import { serverAuthToken, serverAuthHeader } from "../src/server_auth";

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

describe("attachActionResponse — the attach verb (#1344 AC1: attach_detach_action_exercised)", () => {
  let dir: string;
  let attachmentFile: string;
  let rosterFile: string;
  let credentialFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "attach-action-"));
    attachmentFile = join(dir, "attachment.json");
    rosterFile = join(dir, "roster.json");
    credentialFile = join(dir, "attachment-credentials.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("attach adds an upstream and SETS the pointer from the matching roster row (the roster is the candidate source)", () => {
    writeRoster(rosterFile, [row({ machine_id: "peer-01", sshAlias: "peer-one@host", transport: "ssh" })]);
    const body = JSON.parse(
      attachActionResponse(JSON.stringify({ machine_id: "peer-01" }), { attachmentFile, rosterFile, credentialFile }),
    ) as { ok: boolean; attached: boolean; pointer: { sshAlias: string; transport: string; machine_id: string } };
    expect(body.ok).toBe(true);
    expect(body.attached).toBe(true);
    // the pointer's reach coordinates come from the ROSTER ROW, not the caller
    expect(body.pointer).toEqual({ sshAlias: "peer-one@host", transport: "ssh", machine_id: "peer-01" });
    // and it landed on the Slice-2 pointer file, verbatim
    expect(resolveAttachmentPointer({ attachmentFile })).toEqual({
      ok: true,
      attached: true,
      pointer: { sshAlias: "peer-one@host", transport: "ssh", machine_id: "peer-01" },
    });
  });

  it("attach to a machine NOT in the roster is REFUSED — the roster is the sole candidate source, and no pointer is written", () => {
    writeRoster(rosterFile, [row({ machine_id: "peer-01" })]);
    const body = JSON.parse(
      attachActionResponse(JSON.stringify({ machine_id: "ghost-99" }), { attachmentFile, rosterFile, credentialFile }),
    ) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/unknown_machine/);
    // the pointer stays empty — a refused attach never half-writes
    expect(resolveAttachmentPointer({ attachmentFile })).toEqual({ ok: true, attached: false });
  });

  it("attach with base_url + token PROVISIONS the per-attachment credential (D10a), keyed by machine_id", () => {
    writeRoster(rosterFile, [row({ machine_id: "peer-01" })]);
    attachActionResponse(
      JSON.stringify({ machine_id: "peer-01", base_url: "http://127.0.0.1:7777", token: "peer-tok" }),
      { attachmentFile, rosterFile, credentialFile },
    );
    expect(readAttachmentCredential("peer-01", { credentialFile })).toEqual({
      ok: true,
      credential: { baseUrl: "http://127.0.0.1:7777", token: "peer-tok" },
    });
  });

  it("attach WITHOUT credential material sets the pointer but leaves the credential absent (the honest uncredentialed leg)", () => {
    writeRoster(rosterFile, [row({ machine_id: "peer-01" })]);
    attachActionResponse(JSON.stringify({ machine_id: "peer-01" }), { attachmentFile, rosterFile, credentialFile });
    expect(resolveAttachmentPointer({ attachmentFile }).ok).toBe(true);
    expect(readAttachmentCredential("peer-01", { credentialFile })).toEqual({ ok: false, reason: "absent" });
  });

  it("a malformed body (missing machine_id) is refused, never a throw, never a coerced pointer", () => {
    writeRoster(rosterFile, [row({ machine_id: "peer-01" })]);
    expect(() =>
      attachActionResponse(JSON.stringify({ nope: true }), { attachmentFile, rosterFile, credentialFile }),
    ).not.toThrow();
    const body = JSON.parse(
      attachActionResponse(JSON.stringify({ nope: true }), { attachmentFile, rosterFile, credentialFile }),
    ) as { ok: boolean };
    expect(body.ok).toBe(false);
    expect(resolveAttachmentPointer({ attachmentFile })).toEqual({ ok: true, attached: false });
  });
});

// ── #1411 (ADR 0030 §D4): canonical-server fallback ─────────────────────────

describe("attachActionResponse — canonical-server fallback (#1411, ADR 0030 §D4)", () => {
  let dir: string;
  let attachmentFile: string;
  let rosterFile: string;
  let credentialFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "attach-canonical-"));
    attachmentFile = join(dir, "attachment.json");
    rosterFile = join(dir, "roster.json");
    credentialFile = join(dir, "attachment-credentials.json");
    // Empty roster — the canonical server is never a roster row on a client
    writeRoster(rosterFile, []);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const canonicalTopology = (canonical?: { host?: string; port?: number; sshAlias?: string }) =>
    () => ({
      kind: "ok" as const,
      role: "client",
      canonical,
      mode: "fleet",
      posture: "ok",
      freshness: {},
      provenanceSource: "test",
      projection: {} as never,
    });

  it("machine_id not in roster, matches canonical → attach succeeds with canonical coords", () => {
    const body = JSON.parse(
      attachActionResponse(JSON.stringify({ machine_id: "192.168.1.100" }), {
        attachmentFile, rosterFile, credentialFile,
        readTopology: canonicalTopology({ host: "192.168.1.100", sshAlias: "mac-studio" }),
      }),
    ) as { ok: boolean; attached: boolean; pointer: { sshAlias: string; transport: string; machine_id: string } };
    expect(body.ok).toBe(true);
    expect(body.attached).toBe(true);
    expect(body.pointer).toEqual({ sshAlias: "mac-studio", transport: "ssh", machine_id: "192.168.1.100" });
  });

  it("canonical match via sshAlias (when host is absent)", () => {
    const body = JSON.parse(
      attachActionResponse(JSON.stringify({ machine_id: "mac-studio" }), {
        attachmentFile, rosterFile, credentialFile,
        readTopology: canonicalTopology({ sshAlias: "mac-studio" }),
      }),
    ) as { ok: boolean; pointer: { sshAlias: string; transport: string } };
    expect(body.ok).toBe(true);
    expect(body.pointer.sshAlias).toBe("mac-studio");
    expect(body.pointer.transport).toBe("ssh");
  });

  it("canonical has no sshAlias → distinct canonical_no_ssh error code", () => {
    const body = JSON.parse(
      attachActionResponse(JSON.stringify({ machine_id: "192.168.1.100" }), {
        attachmentFile, rosterFile, credentialFile,
        readTopology: canonicalTopology({ host: "192.168.1.100" }),
      }),
    ) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/canonical_no_ssh/);
  });

  it("machine_id not in roster AND not canonical → unknown_machine refusal", () => {
    const body = JSON.parse(
      attachActionResponse(JSON.stringify({ machine_id: "ghost-99" }), {
        attachmentFile, rosterFile, credentialFile,
        readTopology: canonicalTopology({ host: "192.168.1.100", sshAlias: "mac-studio" }),
      }),
    ) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/unknown_machine/);
  });

  it("roster hit takes priority when machine_id is in both roster and canonical", () => {
    writeRoster(rosterFile, [row({ machine_id: "192.168.1.100", sshAlias: "roster-alias", transport: "tailscale" })]);
    const body = JSON.parse(
      attachActionResponse(JSON.stringify({ machine_id: "192.168.1.100" }), {
        attachmentFile, rosterFile, credentialFile,
        readTopology: canonicalTopology({ host: "192.168.1.100", sshAlias: "canonical-alias" }),
      }),
    ) as { ok: boolean; pointer: { sshAlias: string; transport: string } };
    expect(body.ok).toBe(true);
    // Roster wins over canonical
    expect(body.pointer.sshAlias).toBe("roster-alias");
    expect(body.pointer.transport).toBe("tailscale");
  });

  it("credential provisioning works for canonical-sourced attach", () => {
    attachActionResponse(
      JSON.stringify({ machine_id: "192.168.1.100", base_url: "http://127.0.0.1:7777", token: "tok" }),
      {
        attachmentFile, rosterFile, credentialFile,
        readTopology: canonicalTopology({ host: "192.168.1.100", sshAlias: "mac-studio" }),
      },
    );
    expect(readAttachmentCredential("192.168.1.100", { credentialFile })).toEqual({
      ok: true,
      credential: { baseUrl: "http://127.0.0.1:7777", token: "tok" },
    });
  });

  it("no readTopology dep + roster miss → unknown_machine (backward compatible)", () => {
    const body = JSON.parse(
      attachActionResponse(JSON.stringify({ machine_id: "ghost" }), {
        attachmentFile, rosterFile, credentialFile,
        // readTopology intentionally NOT provided
      }),
    ) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/unknown_machine/);
  });

  it("topology reader throws → unknown_machine (graceful degradation)", () => {
    const body = JSON.parse(
      attachActionResponse(JSON.stringify({ machine_id: "192.168.1.100" }), {
        attachmentFile, rosterFile, credentialFile,
        readTopology: () => { throw new Error("boom"); },
      }),
    ) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/unknown_machine/);
  });
});

describe("detachActionResponse — the detach verb (#1344 AC1)", () => {
  let dir: string;
  let attachmentFile: string;
  let rosterFile: string;
  let credentialFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "detach-action-"));
    attachmentFile = join(dir, "attachment.json");
    rosterFile = join(dir, "roster.json");
    credentialFile = join(dir, "attachment-credentials.json");
    writeRoster(rosterFile, [row({ machine_id: "peer-01" })]);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("detach REMOVES the upstream: clears the pointer (back to the empty/local default) and the credential", () => {
    attachActionResponse(
      JSON.stringify({ machine_id: "peer-01", base_url: "http://127.0.0.1:7777", token: "peer-tok" }),
      { attachmentFile, rosterFile, credentialFile },
    );
    expect(resolveAttachmentPointer({ attachmentFile }).ok).toBe(true);

    const body = JSON.parse(
      detachActionResponse(JSON.stringify({ machine_id: "peer-01" }), { attachmentFile, rosterFile, credentialFile }),
    ) as { ok: boolean; attached: boolean };
    expect(body.ok).toBe(true);
    expect(body.attached).toBe(false);
    expect(resolveAttachmentPointer({ attachmentFile })).toEqual({ ok: true, attached: false });
    expect(readAttachmentCredential("peer-01", { credentialFile })).toEqual({ ok: false, reason: "absent" });
  });

  it("detach with no body clears whatever is attached (idempotent — an already-empty detach is a no-op, never a throw)", () => {
    expect(() => detachActionResponse("", { attachmentFile, rosterFile, credentialFile })).not.toThrow();
    const body = JSON.parse(detachActionResponse("", { attachmentFile, rosterFile, credentialFile })) as {
      ok: boolean;
      attached: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.attached).toBe(false);
  });
});

// ── AC3 (sse_cursor_resets_on_switch): a SWITCH resets the SSE cursor ─────────
// A "switch" is a pointer flip to a DIFFERENT server. The verb invokes the
// injected `resetCursorOnSwitch` seam ONLY when the attached origin actually
// changes — the multiplexer's next per-session SSE subscription to the newly
// attached server must open a FRESH stream with NO `?after=` cursor (a different
// server's seqs are meaningless).
describe("attach/detach resets the SSE cursor on a SWITCH (#1344 AC3: sse_cursor_resets_on_switch)", () => {
  let dir: string;
  let attachmentFile: string;
  let rosterFile: string;
  let credentialFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "attach-switch-"));
    attachmentFile = join(dir, "attachment.json");
    rosterFile = join(dir, "roster.json");
    credentialFile = join(dir, "attachment-credentials.json");
    writeRoster(rosterFile, [
      row({ machine_id: "peer-a", sshAlias: "a@host" }),
      row({ machine_id: "peer-b", sshAlias: "b@host" }),
    ]);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a switch (attach to a DIFFERENT peer) invokes resetCursorOnSwitch; re-attaching the SAME peer does NOT", () => {
    let resets = 0;
    const deps = { attachmentFile, rosterFile, credentialFile, resetCursorOnSwitch: () => void resets++ };
    attachActionResponse(JSON.stringify({ machine_id: "peer-a" }), deps); // empty -> A : a switch of origin
    expect(resets).toBe(1);
    attachActionResponse(JSON.stringify({ machine_id: "peer-a" }), deps); // A -> A : NOT a switch
    expect(resets).toBe(1);
    attachActionResponse(JSON.stringify({ machine_id: "peer-b" }), deps); // A -> B : a switch
    expect(resets).toBe(2);
  });

  it("detach from an attached peer invokes resetCursorOnSwitch (leaving a server invalidates its cursors); an already-empty detach does not", () => {
    let resets = 0;
    const deps = { attachmentFile, rosterFile, credentialFile, resetCursorOnSwitch: () => void resets++ };
    detachActionResponse("", deps); // already empty -> no switch
    expect(resets).toBe(0);
    attachActionResponse(JSON.stringify({ machine_id: "peer-a" }), deps);
    expect(resets).toBe(1);
    detachActionResponse(JSON.stringify({ machine_id: "peer-a" }), deps); // A -> empty : a switch
    expect(resets).toBe(2);
  });

  it("integration with the real cursor store: after a switch, the reset store's next per-session plan opens a FRESH stream (no ?after=)", () => {
    const store = new SessionEventResume();
    const deps = { attachmentFile, rosterFile, credentialFile, resetCursorOnSwitch: () => store.reset() };
    attachActionResponse(JSON.stringify({ machine_id: "peer-a" }), deps);

    // simulate the multiplexer having delivered seq=42 on peer-a's session stream
    const url = new URL("http://127.0.0.1/api/session/ses-1/event");
    const plan = store.plan(url)!;
    plan.filter.push(Buffer.from("id: 42\ndata: {}\n\n", "utf8"));
    expect(store.cursor("ses-1")).toBe(42);

    // switch to peer-b -> the store is reset
    attachActionResponse(JSON.stringify({ machine_id: "peer-b" }), deps);
    expect(store.cursor("ses-1")).toBeUndefined();
    // the NEXT subscription opens a fresh stream: no ?after= injected
    const afterSwitch = store.plan(new URL("http://127.0.0.1/api/session/ses-1/event"))!;
    expect(afterSwitch.afterToInject).toBeUndefined();
  });
});

// ── the open design gap this slice OWNS: the pointer + attach/detach routes are
// reachable on a PLAIN STANDALONE BOOT (no opts.fleet, no entitlement). ADR 0027:
// a peer stays `standalone` and must still attach. Before this slice the routes
// were registered ONLY inside the entitlement-gated fleet block.
describe("attach/detach routes are reachable on a STANDALONE boot (#1344 AC1 — the route-registration fix)", () => {
  let dir: string;
  let attachmentFile: string;
  let rosterFile: string;
  let credentialFile: string;
  const PASSWORD = "standalone-service-mint";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "attach-standalone-"));
    attachmentFile = join(dir, "attachment.json");
    rosterFile = join(dir, "roster.json");
    credentialFile = join(dir, "attachment-credentials.json");
    writeRoster(rosterFile, [row({ machine_id: "peer-01", sshAlias: "peer-one@host", transport: "ssh" })]);
    process.env.AMICO_FLEET_ATTACHMENT_FILE = attachmentFile;
    process.env.AMICO_FLEET_ROSTER_FILE = rosterFile;
    process.env.AMICO_FLEET_ATTACHMENT_CREDENTIAL_FILE = credentialFile;
  });
  afterEach(() => {
    delete process.env.AMICO_FLEET_ATTACHMENT_FILE;
    delete process.env.AMICO_FLEET_ROSTER_FILE;
    delete process.env.AMICO_FLEET_ATTACHMENT_CREDENTIAL_FILE;
    rmSync(dir, { recursive: true, force: true });
  });

  it("POST /amicode/fleet/attach then /detach work with NO opts.fleet (a standalone peer attaches), and GET /amicode/fleet/attachment reflects it", async () => {
    const svc = createAmicodeService({ password: PASSWORD }); // NO fleet block — a plain standalone boot
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    const token = serverAuthToken(PASSWORD);
    const auth = serverAuthHeader(PASSWORD); // POST rides the Basic header (the ?auth_token= carrier is GET-only, server.ts)
    try {
      const attach = await fetch(`${origin}/amicode/fleet/attach`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: auth },
        body: JSON.stringify({ machine_id: "peer-01" }),
      });
      expect(attach.status).toBe(200);
      expect(((await attach.json()) as { attached: boolean }).attached).toBe(true);

      const status = await fetch(`${origin}/amicode/fleet/attachment?auth_token=${encodeURIComponent(token)}`);
      expect(status.status).toBe(200);
      const statusBody = (await status.json()) as { attached: boolean; pointer: { machine_id: string } | null };
      expect(statusBody.attached).toBe(true);
      expect(statusBody.pointer?.machine_id).toBe("peer-01");

      const detach = await fetch(`${origin}/amicode/fleet/detach`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: auth },
        body: JSON.stringify({ machine_id: "peer-01" }),
      });
      expect(detach.status).toBe(200);
      expect(((await detach.json()) as { attached: boolean }).attached).toBe(false);

      const after = await fetch(`${origin}/amicode/fleet/attachment?auth_token=${encodeURIComponent(token)}`);
      expect(((await after.json()) as { attached: boolean }).attached).toBe(false);
    } finally {
      await svc.stop();
    }
  });
});
