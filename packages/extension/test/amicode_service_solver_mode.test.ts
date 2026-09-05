// amicode-service solver-mode unit tests (#798) — the contract the golden
// fixture cannot pin: the seeded sandbox has NO entitlements.toml, so the
// recorded piccolo release takes the settled no-op path and never touches
// disk. These tests drive the persistence half (the entitlement revoke + the
// {mode:"piccolo",status:"switching"} request the extension's watcher
// consumes), the refusal shapes, and the loopback gate — ported from the
// fork's connections.ts @ v1.18.10-amicode.21 semantics.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAmicodeService } from "../src/amicode_service";
import {
  solverModeResponse,
  entitlementsFile,
  solverModeFile,
  PICCOLO_FLIP_WARNING,
} from "../src/amicode_service/solver_mode";

describe("solverModeResponse — refusal shapes (fixed strings, sibling discipline)", () => {
  it("off-shape body refuses with bad_request", () => {
    const parsed = JSON.parse(solverModeResponse("{}"));
    expect(parsed).toEqual({ ok: false, mode: null, error: 'bad_request: body must be JSON {mode:"piccolo"}' });
  });

  it("non-JSON body refuses with bad_request", () => {
    expect(JSON.parse(solverModeResponse("not json")).ok).toBe(false);
  });

  it("array body refuses with bad_request", () => {
    expect(JSON.parse(solverModeResponse('["piccolo"]')).ok).toBe(false);
  });

  it("hp refuses with unsupported_mode — a second hp writer is the duplicate flip ADR 0001 forbids", () => {
    const parsed = JSON.parse(solverModeResponse(JSON.stringify({ mode: "hp" })));
    expect(parsed).toEqual({
      ok: false,
      mode: null,
      error: "unsupported_mode: only piccolo is selectable here; hp follows a Company Compute credential",
    });
  });

  it("non-loopback bind refuses with non_loopback", () => {
    const parsed = JSON.parse(solverModeResponse(JSON.stringify({ mode: "piccolo" }), { bindHostname: "10.1.2.3" }));
    expect(parsed).toEqual({
      ok: false,
      mode: null,
      error: "non_loopback: solver mutations serve loopback binds only",
    });
  });
});

describe("solverModeResponse — persistence (the watcher's shared file contract)", () => {
  let ops: string;
  let savedOps: string | undefined;

  beforeEach(() => {
    ops = mkdtempSync(join(tmpdir(), "amicode-solver-mode-"));
    savedOps = process.env.AMICODE_OPS_DIR;
    process.env.AMICODE_OPS_DIR = ops;
  });

  afterEach(() => {
    if (savedOps === undefined) delete process.env.AMICODE_OPS_DIR;
    else process.env.AMICODE_OPS_DIR = savedOps;
    rmSync(ops, { recursive: true, force: true });
  });

  it("settled piccolo setup is a NO-OP: accepted, nothing written", () => {
    const body = solverModeResponse(JSON.stringify({ mode: "piccolo" }));
    expect(JSON.parse(body)).toEqual({ ok: true, mode: "piccolo", error: null });
    expect(existsSync(entitlementsFile())).toBe(false);
    expect(existsSync(solverModeFile())).toBe(false);
  });

  it("granted `issimo` is revoked and the switching request is written for the watcher", () => {
    writeFileSync(entitlementsFile(), 'codes = ["issimo", "other-code"]\n');
    const body = solverModeResponse(JSON.stringify({ mode: "piccolo" }));
    expect(JSON.parse(body)).toEqual({ ok: true, mode: "piccolo", error: null });
    // other codes preserved, `issimo` gone — byte-compatible with the
    // extension's applyEntitlementForMode writer
    expect(readFileSync(entitlementsFile(), "utf8")).toBe('codes = ["other-code"]\n');
    // the request the extension's watchSolverMode polls for and answers with
    // writeSolverModeReady
    expect(JSON.parse(readFileSync(solverModeFile(), "utf8"))).toEqual({ mode: "piccolo", status: "switching" });
  });

  it("unwritable ops dir degrades to piccolo_flip_failed — the flip IS the operation", () => {
    // AMICODE_OPS_DIR points at a REGULAR FILE: every ops-dir join under it
    // fails (ENOTDIR — not ENOENT, which would be the legitimate no-op)
    const blocker = join(ops, "not-a-dir");
    writeFileSync(blocker, "blocked");
    process.env.AMICODE_OPS_DIR = blocker;
    const parsed = JSON.parse(solverModeResponse(JSON.stringify({ mode: "piccolo" })));
    expect(parsed).toEqual({ ok: false, mode: null, error: PICCOLO_FLIP_WARNING });
  });
});

describe("solver-mode route on the service — served wiring", () => {
  it("POST /amicode/solver-mode round-trips through the service and persists the toggle", async () => {
    const ops = mkdtempSync(join(tmpdir(), "amicode-solver-mode-svc-"));
    const savedOps = process.env.AMICODE_OPS_DIR;
    process.env.AMICODE_OPS_DIR = ops;
    const service = createAmicodeService({ password: "solver-mode-test" });
    try {
      const url = await service.start();
      const r = await fetch(new URL("/amicode/solver-mode", url), {
        method: "POST",
        headers: { Authorization: service.authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "piccolo" }),
      });
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("application/json");
      expect(await r.json()).toEqual({ ok: true, mode: "piccolo", error: null });
      // a granted entitlement makes this a REAL flip: the persisted request
      // the extension watcher consumes must land
      writeFileSync(join(ops, "entitlements.toml"), 'codes = ["issimo"]\n');
      const r2 = await fetch(new URL("/amicode/solver-mode", url), {
        method: "POST",
        headers: { Authorization: service.authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "piccolo" }),
      });
      expect(await r2.json()).toEqual({ ok: true, mode: "piccolo", error: null });
      expect(readFileSync(solverModeFile(), "utf8")).toBe('{"mode":"piccolo","status":"switching"}');
      expect(readFileSync(join(ops, "entitlements.toml"), "utf8")).toBe("codes = []\n");
    } finally {
      await service.stop();
      if (savedOps === undefined) delete process.env.AMICODE_OPS_DIR;
      else process.env.AMICODE_OPS_DIR = savedOps;
      rmSync(ops, { recursive: true, force: true });
    }
  });
});
