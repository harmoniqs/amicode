// amicode-service keeper bootstrap pointer tests (#1341, ADR 0027 §4/D7) —
// "reach the keeper" must resolve WITHOUT reading the very roster.json the
// keeper hosts (that would be circular: the keeper IS the registry host).
// This is a NEW, first-class resolvable coordinate — a sibling of the future
// D6 switch-control pointer — with its OWN file/env source
// (AMICO_FLEET_KEEPER_FILE), mirroring roster.ts's RosterDeps injection style
// (rosterFile / AMICO_FLEET_ROSTER_FILE). Slice 1 ships the coordinate + its
// resolver; Slice 2 wires a consumer (roster_route_resolves_to_distinct_keeper).
//
// Two kinds of proof for "non-circular":
//   (a) BEHAVIORAL — resolution succeeds/fails purely on the pointer file's
//       own presence/content, independent of whatever the roster file holds
//       (even an absent or malformed roster never perturbs the answer).
//   (b) STRUCTURAL — the module's source never imports/references anything
//       from the roster contract (mirrors fleet_fallback.test.ts's module-
//       discipline pattern: "the module contains NO JSON.parse" etc.).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveKeeperPointer,
  keeperPointerFilePath,
  writeKeeperPointerFile,
  KEEPER_POINTER_RELPATH,
  type KeeperPointer,
} from "../src/amicode_service/keeper_pointer";

const POINTER: KeeperPointer = { sshAlias: "keeper-host", transport: "ssh" };

describe("resolveKeeperPointer — AC3 (#1341): resolves the keeper's address from its OWN source", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keeper-ptr-"));
    file = join(dir, "keeper.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("resolves a written pointer from an injected file path, verbatim", () => {
    writeKeeperPointerFile(POINTER, { keeperFile: file });
    const result = resolveKeeperPointer({ keeperFile: file });
    expect(result).toEqual({ ok: true, pointer: POINTER });
  });

  it("an absent pointer file is an honest miss — never a throw, never a fabricated address", () => {
    const result = resolveKeeperPointer({ keeperFile: join(dir, "does-not-exist.json") });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a miss");
    expect(result.error).toMatch(/keeper_pointer_absent/);
  });

  it("a malformed pointer file (missing sshAlias) is rejected, never coerced", () => {
    writeFileSync(file, JSON.stringify({ transport: "ssh" }));
    const result = resolveKeeperPointer({ keeperFile: file });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.error).toMatch(/sshAlias/);
  });

  it("a non-JSON pointer file is rejected, never a throw", () => {
    writeFileSync(file, "not json at all {{{");
    const result = resolveKeeperPointer({ keeperFile: file });
    expect(result.ok).toBe(false);
  });

  it("respects $AMICO_FLEET_KEEPER_FILE when no path is injected (the env seam, sibling to AMICO_FLEET_ROSTER_FILE)", () => {
    const saved = process.env.AMICO_FLEET_KEEPER_FILE;
    process.env.AMICO_FLEET_KEEPER_FILE = file;
    try {
      writeKeeperPointerFile(POINTER, {});
      expect(keeperPointerFilePath({})).toBe(file);
      expect(resolveKeeperPointer({})).toEqual({ ok: true, pointer: POINTER });
    } finally {
      if (saved === undefined) delete process.env.AMICO_FLEET_KEEPER_FILE;
      else process.env.AMICO_FLEET_KEEPER_FILE = saved;
    }
  });

  it("an injected path takes precedence over the env override (mirrors rosterFilePath's own precedence)", () => {
    const envFile = join(dir, "env-keeper.json");
    writeFileSync(envFile, JSON.stringify({ sshAlias: "wrong-one", transport: "ssh" }));
    const saved = process.env.AMICO_FLEET_KEEPER_FILE;
    process.env.AMICO_FLEET_KEEPER_FILE = envFile;
    try {
      writeKeeperPointerFile(POINTER, { keeperFile: file });
      expect(resolveKeeperPointer({ keeperFile: file })).toEqual({ ok: true, pointer: POINTER });
    } finally {
      if (saved === undefined) delete process.env.AMICO_FLEET_KEEPER_FILE;
      else process.env.AMICO_FLEET_KEEPER_FILE = saved;
    }
  });
});

describe("resolveKeeperPointer — AC3 (#1341): NON-CIRCULAR — never resolves via roster.json", () => {
  let dir: string;
  let keeperFile: string;
  let rosterFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keeper-noncirc-"));
    keeperFile = join(dir, "keeper.json");
    rosterFile = join(dir, "roster.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("resolves the keeper successfully even when the roster file is ABSENT (no dependency on roster.json existing)", () => {
    expect(existsSync(rosterFile)).toBe(false);
    writeKeeperPointerFile(POINTER, { keeperFile });
    const result = resolveKeeperPointer({ keeperFile });
    expect(result).toEqual({ ok: true, pointer: POINTER });
    expect(existsSync(rosterFile)).toBe(false); // resolving never created it either
  });

  it("resolves the keeper successfully even when the roster file is MALFORMED (resolution never reads it, so corruption there cannot affect it)", () => {
    writeFileSync(rosterFile, "{{{ not a lawful roster document");
    writeKeeperPointerFile(POINTER, { keeperFile });
    const result = resolveKeeperPointer({ keeperFile });
    expect(result).toEqual({ ok: true, pointer: POINTER });
  });

  it("resolves the SAME pointer regardless of what the roster's rows claim (the keeper coordinate is independent of roster content)", () => {
    writeFileSync(
      rosterFile,
      JSON.stringify({
        schema_version: 1,
        rows: [{ machine_id: "some-other-host", name: "x", server_mode: "server", capabilities: [], sshAlias: "decoy", transport: "ssh", last_report: "2026-09-20T00:00:00Z", health: "reachable" }],
      }),
    );
    writeKeeperPointerFile(POINTER, { keeperFile });
    const result = resolveKeeperPointer({ keeperFile });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a resolved pointer");
    expect(result.pointer.sshAlias).toBe("keeper-host"); // NOT "decoy" — never read off the roster
  });

  it("the keeper-pointer cache path is its OWN relpath, distinct from the roster's and fleet.json's", () => {
    expect(KEEPER_POINTER_RELPATH).not.toMatch(/roster\.json$/);
    expect(KEEPER_POINTER_RELPATH).not.toMatch(/fleet\.json$/);
  });

  it("module discipline: keeper_pointer.ts's IMPORTS never reach into the roster contract (structural non-circularity — prose may mention roster.ts for context; imports may not)", () => {
    const modulePath = join(__dirname, "..", "src", "amicode_service", "keeper_pointer.ts");
    const src = readFileSync(modulePath, "utf8");
    const importLines = src.match(/^import .+$/gm) ?? [];
    expect(importLines.length).toBeGreaterThan(0); // sanity: the file does import something
    for (const line of importLines) {
      expect(line).not.toMatch(/roster/i);
      expect(line).not.toMatch(/@amicode\/schema/);
    }
  });
});
