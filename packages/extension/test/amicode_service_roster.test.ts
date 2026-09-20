// amicode-service roster route tests (#1318, ADR 0026) — the host-owned,
// fleet-wide roster surface: GET /amicode/roster (read) + POST /amicode/roster
// (self-report). These pin the route-level contract the schema suite
// (packages/schema/test/fleet_roster.test.ts) cannot: the single-writer
// persistence (AC3) and the loopback + auth mutation guard (AC6), mirroring the
// solver-mode route tests (the loopback-mutation-guard pattern, #798).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAmicodeService } from "../src/amicode_service";
import { rosterReportResponse, rosterReadResponse } from "../src/amicode_service/roster";

const ROW_A = {
  machine_id: "mac-studio-01",
  name: "Studio",
  server_mode: "server",
  capabilities: ["compute"],
  sshAlias: "studio",
  transport: "tailscale",
  last_report: "2026-09-20T10:00:00Z",
  health: "reachable",
};
const ROW_B = {
  machine_id: "macbook-02",
  name: "MacBook",
  server_mode: "client",
  capabilities: ["roaming"],
  sshAlias: "macbook",
  transport: "ssh",
  last_report: "2026-09-20T11:00:00Z",
  health: "reachable",
};

type Row = typeof ROW_A;
const rowsOf = (body: string): Row[] => (JSON.parse(body) as { rows: Row[] }).rows;
const byMachine = (rows: Row[]) => new Map(rows.map((r) => [r.machine_id, r]));

describe("roster route — AC3: a self-report touches ONLY the reporting machine's row", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "roster-"));
    file = join(dir, "roster.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a first self-report creates the reporting machine's row, readable back verbatim", () => {
    const body = JSON.parse(rosterReportResponse(JSON.stringify(ROW_A), { rosterFile: file }));
    expect(body).toEqual({ ok: true, machine_id: "mac-studio-01", error: null });
    const rows = rowsOf(rosterReadResponse({ rosterFile: file }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(ROW_A);
  });

  it("a SECOND machine's report does NOT mutate the first machine's row", () => {
    rosterReportResponse(JSON.stringify(ROW_A), { rosterFile: file });
    rosterReportResponse(JSON.stringify(ROW_B), { rosterFile: file });
    const byId = byMachine(rowsOf(rosterReadResponse({ rosterFile: file })));
    expect(byId.size).toBe(2);
    expect(byId.get("mac-studio-01")).toEqual(ROW_A); // untouched by B's report
    expect(byId.get("macbook-02")).toEqual(ROW_B);
  });

  it("a machine's re-report updates ONLY its own row — no duplicate, others byte-identical", () => {
    rosterReportResponse(JSON.stringify(ROW_A), { rosterFile: file });
    rosterReportResponse(JSON.stringify(ROW_B), { rosterFile: file });
    const updatedA = { ...ROW_A, health: "degraded", last_report: "2026-09-20T12:30:00Z" };
    rosterReportResponse(JSON.stringify(updatedA), { rosterFile: file });
    const rows = rowsOf(rosterReadResponse({ rosterFile: file }));
    const byId = byMachine(rows);
    expect(rows).toHaveLength(2); // A was replaced in place, not appended
    expect(byId.get("mac-studio-01")).toEqual(updatedA); // its own row updated
    expect(byId.get("macbook-02")).toEqual(ROW_B); // the peer row untouched
  });

  it("GET on an absent roster answers an empty, well-formed roster (never a throw)", () => {
    const body = JSON.parse(rosterReadResponse({ rosterFile: join(dir, "does-not-exist.json") }));
    expect(body.ok).toBe(true);
    expect(body.rows).toEqual([]);
    expect(body.schema_version).toBe(1);
  });
});

describe("roster route — AC6: an unauthenticated write is refused; the write calls the loopback guard", () => {
  it("rosterReportResponse on a NON-loopback bind refuses with non_loopback (the mutation guard)", () => {
    const parsed = JSON.parse(rosterReportResponse(JSON.stringify(ROW_A), { bindHostname: "10.1.2.3" }));
    expect(parsed).toEqual({
      ok: false,
      machine_id: null,
      error: "non_loopback: roster self-report serves loopback binds only",
    });
  });

  it("a loopback bind PASSES the guard (127.0.0.1 is served, never refused non_loopback)", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-lb-"));
    try {
      const parsed = JSON.parse(
        rosterReportResponse(JSON.stringify(ROW_A), { bindHostname: "127.0.0.1", rosterFile: join(dir, "roster.json") }),
      );
      expect(parsed).toEqual({ ok: true, machine_id: "mac-studio-01", error: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an UNAUTHENTICATED POST /amicode/roster is refused 401 (no data-plane credential), never served", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-auth-"));
    const file = join(dir, "roster.json");
    const saved = process.env.AMICO_FLEET_ROSTER_FILE;
    process.env.AMICO_FLEET_ROSTER_FILE = file;
    // credential mode (the default) — every non-public-UI request needs a valid mint
    const service = createAmicodeService({ password: "roster-auth-test" });
    try {
      const url = await service.start();
      const res = await fetch(new URL("/amicode/roster", url), {
        method: "POST",
        headers: { "Content-Type": "application/json" }, // NO Authorization header
        body: JSON.stringify(ROW_A),
      });
      expect(res.status).toBe(401);
      expect((await res.json()).ok).toBe(false);
      // the refused write NEVER touched the store
      expect(existsSync(file)).toBe(false);
    } finally {
      await service.stop();
      if (saved === undefined) delete process.env.AMICO_FLEET_ROSTER_FILE;
      else process.env.AMICO_FLEET_ROSTER_FILE = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("roster route — served through the amicode service (wiring)", () => {
  it("POST then GET /amicode/roster round-trips the reporting machine's row through the live service", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-svc-"));
    const file = join(dir, "roster.json");
    const saved = process.env.AMICO_FLEET_ROSTER_FILE;
    process.env.AMICO_FLEET_ROSTER_FILE = file;
    const service = createAmicodeService({ password: "roster-test" });
    try {
      const url = await service.start();
      const post = await fetch(new URL("/amicode/roster", url), {
        method: "POST",
        headers: { Authorization: service.authHeader, "Content-Type": "application/json" },
        body: JSON.stringify(ROW_A),
      });
      expect(post.status).toBe(200);
      expect(await post.json()).toEqual({ ok: true, machine_id: "mac-studio-01", error: null });
      const get = await fetch(new URL("/amicode/roster", url), { headers: { Authorization: service.authHeader } });
      expect(get.status).toBe(200);
      const body = (await get.json()) as { ok: boolean; rows: Row[] };
      expect(body.rows).toHaveLength(1);
      expect(body.rows[0]).toEqual(ROW_A);
    } finally {
      await service.stop();
      if (saved === undefined) delete process.env.AMICO_FLEET_ROSTER_FILE;
      else process.env.AMICO_FLEET_ROSTER_FILE = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
