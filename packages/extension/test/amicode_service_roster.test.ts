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
import { rosterReportResponse, rosterReadResponse, buildBootSelfReportRow } from "../src/amicode_service/roster";
import { placementDescriptor, parseRosterRow, fleetTopologyPath } from "@amicode/schema";

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

// #1341 (ADR 0027 §4–§5, D7/D8) — Slice 1: the `serving` advertisement is a
// placement-ready descriptor (reachable + serving), and advertising it is
// inert with respect to `server_mode` / `fleet.json`. The roster route needs
// NO code change to carry `serving` (capabilities[] is already an open set —
// ADR 0026) — these tests pin the ROUTE-level contract end to end, through the
// placementDescriptor helper that only exists once #1341's schema change lands.
describe("roster route — #1341 AC1: a `serving` advertisement carries the tag + reach coordinates through GET", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "roster-serving-"));
    file = join(dir, "roster.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a peer that advertises writes a row whose GET carries the `serving` tag + sshAlias/transport, present and readable as a placement descriptor", () => {
    const advertising = {
      ...ROW_A,
      machine_id: "peer-01",
      capabilities: ["serving"],
      sshAlias: "peer-01-ssh",
      transport: "ssh",
      health: "reachable",
    };
    const post = JSON.parse(rosterReportResponse(JSON.stringify(advertising), { rosterFile: file }));
    expect(post).toEqual({ ok: true, machine_id: "peer-01", error: null });

    const rows = rowsOf(rosterReadResponse({ rosterFile: file }));
    expect(rows).toHaveLength(1);
    expect(rows[0].capabilities).toContain("serving"); // the tag is present
    expect(rows[0].sshAlias).toBe("peer-01-ssh"); // reach coordinates present
    expect(rows[0].transport).toBe("ssh");

    // AC2: the row reads as a placement-ready descriptor, not a display chip —
    // reachable + serving are the facts a future scheduler would consume.
    const d = placementDescriptor(rows[0]);
    expect(d).toEqual({
      machine_id: "peer-01",
      serving: true,
      reachable: true,
      sshAlias: "peer-01-ssh",
      transport: "ssh",
    });
    expect(Object.prototype.hasOwnProperty.call(d, "headroom")).toBe(false); // H2-only, not asserted here
  });

  it("a peer that is NOT serving reads placementDescriptor(row).serving === false — the tag is what drives it, not presence on the roster", () => {
    rosterReportResponse(JSON.stringify({ ...ROW_A, capabilities: ["compute"] }), { rosterFile: file });
    const rows = rowsOf(rosterReadResponse({ rosterFile: file }));
    expect(placementDescriptor(rows[0]).serving).toBe(false);
  });
});

describe("roster route — #1341 AC4: advertising `serving` never touches server_mode or fleet.json", () => {
  it("server_mode round-trips byte-identical — advertising serving never derives or coerces a role", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-servermode-"));
    const file = join(dir, "roster.json");
    try {
      const advertising = { ...ROW_A, server_mode: "standalone", capabilities: ["serving"] };
      rosterReportResponse(JSON.stringify(advertising), { rosterFile: file });
      const rows = rowsOf(rosterReadResponse({ rosterFile: file }));
      // NOT coerced to "server" just because it advertised serving:
      expect(rows[0].server_mode).toBe("standalone");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("advertising serving writes ONLY the roster file — the fleet.json topology path is never created", () => {
    const home = mkdtempSync(join(tmpdir(), "roster-fakehome-"));
    const rosterDir = mkdtempSync(join(tmpdir(), "roster-file-"));
    const file = join(rosterDir, "roster.json");
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const topologyPathBefore = fleetTopologyPath();
      expect(existsSync(topologyPathBefore)).toBe(false); // fresh fake $HOME, nothing there yet
      rosterReportResponse(JSON.stringify({ ...ROW_A, capabilities: ["serving"] }), { rosterFile: file });
      expect(existsSync(file)).toBe(true); // the roster write landed
      expect(existsSync(fleetTopologyPath())).toBe(false); // fleet.json was NEVER written
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(rosterDir, { recursive: true, force: true });
    }
  });

  it("the roster route module contains no reference to the fleet.json writer (module discipline — never a second parser/writer of fleet.json, ADR 0023)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const modulePath = fileURLToPath(new URL("../src/amicode_service/roster.ts", import.meta.url));
    const src = readFileSync(modulePath, "utf8");
    expect(src).not.toMatch(/writeFleetConfig|fleetTopologyPath|FLEET_TOPOLOGY_RELPATH/);
  });
});

// #1379: the boot-time `serving` advertisement — an engine-armed machine writes
// `serving` to its roster row's capabilities[] on boot; a client (never-fork,
// hosted-only) does NOT. The row also carries `device_type` from the #1368
// self-report vocabulary.
describe("boot self-report — #1379: the `serving` advertisement on boot", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "roster-boot-"));
    file = join(dir, "roster.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // AC1: an engine-armed machine writes `serving` to capabilities
  it("an engine-armed machine's boot row carries `serving` in capabilities", () => {
    const row = buildBootSelfReportRow({
      machineId: "studio-01",
      name: "Studio",
      serverMode: "server",
      sshAlias: "studio-ssh",
      transport: "tailscale",
      engineArmed: true,
    });
    expect(row.capabilities).toContain("serving");
  });

  // AC4: the composed row passes parseRosterRow validation
  it("the composed boot row passes parseRosterRow validation", () => {
    const row = buildBootSelfReportRow({
      machineId: "studio-01",
      name: "Studio",
      serverMode: "server",
      sshAlias: "studio-ssh",
      transport: "tailscale",
      engineArmed: true,
    });
    const parsed = parseRosterRow(row);
    expect(parsed.ok).toBe(true);
  });

  // AC2: the row's device_type is populated when the caller provides it
  it("the boot row carries device_type when the caller provides a detected form factor", () => {
    const row = buildBootSelfReportRow({
      machineId: "studio-01",
      name: "Studio",
      serverMode: "server",
      sshAlias: "studio-ssh",
      transport: "tailscale",
      engineArmed: true,
      deviceType: "desktop",
    });
    expect(row.device_type).toBe("desktop");
  });

  // AC2 (absent case): device_type is absent, not fabricated, when unknown
  it("the boot row omits device_type when the caller has no form factor (never fabricated)", () => {
    const row = buildBootSelfReportRow({
      machineId: "studio-01",
      name: "Studio",
      serverMode: "server",
      sshAlias: "studio-ssh",
      transport: "tailscale",
      engineArmed: true,
    });
    expect(row.device_type).toBeUndefined();
  });

  // AC3: placementDescriptor reads `serving: true` off an engine-armed boot row
  it("placementDescriptor(row) returns serving:true for an engine-armed boot row", () => {
    const row = buildBootSelfReportRow({
      machineId: "studio-01",
      name: "Studio",
      serverMode: "server",
      sshAlias: "studio-ssh",
      transport: "tailscale",
      engineArmed: true,
    });
    const d = placementDescriptor(row);
    expect(d.serving).toBe(true);
  });

  // AC5: a client (NOT engine-armed) does NOT write `serving`
  it("a non-engine-armed client's boot row does NOT carry `serving`", () => {
    const row = buildBootSelfReportRow({
      machineId: "macbook-02",
      name: "MacBook",
      serverMode: "client",
      sshAlias: "macbook-ssh",
      transport: "ssh",
      engineArmed: false,
    });
    expect(row.capabilities).not.toContain("serving");
    expect(placementDescriptor(row).serving).toBe(false);
  });

  // AC5 + AC4: the client boot row still validates
  it("a non-engine-armed client's boot row passes parseRosterRow validation", () => {
    const row = buildBootSelfReportRow({
      machineId: "macbook-02",
      name: "MacBook",
      serverMode: "client",
      sshAlias: "macbook-ssh",
      transport: "ssh",
      engineArmed: false,
    });
    const parsed = parseRosterRow(row);
    expect(parsed.ok).toBe(true);
  });

  // AC1 + persistence: the boot self-report writes to the roster file
  it("bootSelfReport writes the row to the roster file and reads back with `serving`", () => {
    const result = JSON.parse(
      rosterReportResponse(
        JSON.stringify(
          buildBootSelfReportRow({
            machineId: "studio-01",
            name: "Studio",
            serverMode: "server",
            sshAlias: "studio-ssh",
            transport: "tailscale",
            engineArmed: true,
            deviceType: "desktop",
          }),
        ),
        { rosterFile: file },
      ),
    );
    expect(result.ok).toBe(true);
    const rows = JSON.parse(rosterReadResponse({ rosterFile: file })).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].capabilities).toContain("serving");
    expect(rows[0].device_type).toBe("desktop");
  });
});
