// Fleet & Versions panel (#527) — spec-20260823-094507 D3 + the Measurement
// Protocol's `panel_renders_doctor` criterion.
//
// The load-bearing invariant (view-over-CLI): the panel is a pure view over
// `amico doctor --json`'s report. Every rendered fact — surface name, running
// version, source version, verdict chip — traces verbatim to the report object;
// the ONLY decision the panel makes is the upgrade control's enabled state,
// derived from the verdict chip (view logic, never a version comparison —
// "a fact the panel shows that doctor didn't say is a bug").
//
// Fixtures: committed doctor JSON under test/fixtures/doctor/, hand-written
// against the contract #525 committed (packages/amico-run/schemas/
// doctor-report.schema.json). The issue's Testing Decisions call these shared
// contract fixtures — schema-validated in the sibling slice's suite, consumed
// here; this suite re-validates them against the SAME committed schema so a
// fixture edit cannot silently drift from the contract.
//
// Schema-validation choice (documented per the issue's deliverable 3): the
// validator is a small local JSON-Schema-subset engine in THIS file reading the
// COMMITTED schema from the sibling package — not a deep import of
// @amicode/amico-run/src/doctor_schema (the package's public entry does not
// export it, and deep imports past an entry point are fragile), and not the
// extension's vault_card_validator (it predates type-arrays: the doctor
// schema's `"type": ["string", "null"]` would pass unchecked there). Same
// zero-dependency approach as both of those.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as vscode from "vscode";

import {
  renderFleetSection,
  upgradeEnabled,
  buildDoctorArgv,
  buildUpgradeArgv,
  runDoctor,
  runUpgrade,
  readLastReceipt,
  registerFleetPanel,
  _resetFleetPanelForTesting,
  type DoctorReport,
  type SpawnLike,
  type DoctorOutcome,
} from "../src/fleet_panel";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "fixtures", "doctor");
// test/ → packages/extension/ → packages/ → the amico-run package's committed
// contract (the same file #525's own suite validates against).
const DOCTOR_SCHEMA_PATH = join(HERE, "..", "..", "amico-run", "schemas", "doctor-report.schema.json");

const FIXTURE_NAMES = ["doctor-current.json", "doctor-stale.json", "doctor-integrity-failure.json"] as const;

interface FixtureReport {
  surfaces: Array<{
    surface: string;
    version: string | null;
    source_version: string | null;
    verdict: string;
    evidence: string[];
  }>;
}

const fixture = (name: string): FixtureReport =>
  JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as FixtureReport;

// ─── local JSON-Schema-subset validator (keywords the doctor schema uses) ────

type JsonSchema = Record<string, unknown>;
type SchemaError = { path: string; message: string };

function checkType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}

function validateSubset(value: unknown, schema: JsonSchema, at = "$"): SchemaError[] {
  const errors: SchemaError[] = [];
  const push = (p: string, message: string) => errors.push({ path: p, message });

  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) {
    push(at, `must be one of ${(schema.enum as unknown[]).map((v) => JSON.stringify(v)).join(", ")}`);
  }

  const type = schema.type;
  if (typeof type === "string" && !checkType(value, type)) {
    push(at, `must be ${type}`);
    return errors;
  }
  if (Array.isArray(type) && !(type as string[]).some((t) => checkType(value, t))) {
    push(at, `must be one of ${(type as string[]).join(" | ")}`);
    return errors;
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      push(at, `must have at least ${schema.minItems} items (found ${value.length})`);
    }
    if (schema.items && typeof schema.items === "object") {
      value.forEach((v, i) =>
        errors.push(...validateSubset(v, schema.items as JsonSchema, `${at}[${i}]`)),
      );
    }
    return errors;
  }

  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!(key in obj)) push(at, `missing required field "${key}"`);
      }
    }
    if (schema.properties && typeof schema.properties === "object") {
      for (const [key, sub] of Object.entries(schema.properties as Record<string, JsonSchema>)) {
        if (key in obj) errors.push(...validateSubset(obj[key], sub, `${at}.${key}`));
      }
    }
    if (schema.additionalProperties === false && schema.properties && typeof schema.properties === "object") {
      const allowed = new Set(Object.keys(schema.properties as Record<string, unknown>));
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) push(`${at}.${key}`, `additional property not allowed here`);
      }
    }
    return errors;
  }

  if (typeof value === "string" && typeof schema.minLength === "number" && value.length < schema.minLength) {
    push(at, `must be at least ${schema.minLength} characters`);
  }
  return errors;
}

const DOCTOR_SCHEMA = JSON.parse(readFileSync(DOCTOR_SCHEMA_PATH, "utf8")) as JsonSchema;

/** The upgrade button element for one surface, extracted from the rendered
 *  section — assertion target for the disabled DOM property (the AC pins the
 *  `disabled` attribute, not a class name). */
function upgradeButtonFor(html: string, surface: string): string {
  const m = new RegExp(
    `<button[^>]*data-action="upgrade"[^>]*data-surface="${surface.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>`,
  ).exec(html);
  if (m === null) throw new Error(`no upgrade button rendered for surface "${surface}"`);
  return m[0];
}

const isDisabled = (buttonTag: string): boolean => /\bdisabled\b/.test(buttonTag);

// ─── fixtures: the committed contract floor ──────────────────────────────────

describe("fleet panel — doctor fixtures validate against the committed schema", () => {
  it("the committed schema is found and pins six surfaces", () => {
    // Guard: an empty or moved schema would make every validation vacuous.
    const surfaces = (DOCTOR_SCHEMA.properties as Record<string, JsonSchema>).surfaces as JsonSchema;
    expect(surfaces.minItems).toBe(6);
  });

  it("#804: the committed schema is v2 — schema-stamped + component verdicts on the agent-cards records", () => {
    const top = DOCTOR_SCHEMA.properties as Record<string, JsonSchema>;
    expect(top.schema_version.enum).toEqual(["2"]);
    const items = (top.surfaces as JsonSchema).items as JsonSchema;
    const recordProps = (items.properties as Record<string, JsonSchema>);
    expect(recordProps.components).toBeDefined();
  });

  for (const name of FIXTURE_NAMES) {
    it(`${name}: every record carries surface/version/verdict/evidence per the contract`, () => {
      const report = fixture(name);
      const errors = validateSubset(report, DOCTOR_SCHEMA);
      expect(errors.map((e) => `${e.path}: ${e.message}`).join("\n")).toBe("");
    });
  }

  it("#804 AC7 — tolerate-then-warn: the PRE-BUMP (v1) schema accepts the bumped v2 report; the panel renders it unchanged", () => {
    // the v1 contract shape, verbatim: open additionalProperties, no
    // schema_version, no components — the fleet watchdog / settings panel
    // validators that shipped ahead of the bump
    const V1_SCHEMA: JsonSchema = {
      type: "object",
      properties: {
        surfaces: {
          type: "array",
          minItems: 6,
          items: {
            type: "object",
            additionalProperties: true,
            properties: {
              surface: { enum: ["server-binary", "extension", "vendored-binary", "staged-skills", "agent-cards-global", "agent-cards-staging"] },
              version: { type: ["string", "null"] },
              source_version: { type: ["string", "null"] },
              verdict: { enum: ["current", "stale", "integrity-failure", "unknown"] },
              evidence: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
            },
            required: ["surface", "version", "verdict", "evidence"],
          },
        },
      },
      required: ["surfaces"],
    };
    const report = fixture("doctor-current.json");
    // the v2 fields (schema_version + components) ride through the old
    // validator without a rejection — old validators never reject an entire
    // report over a new field (H5's compat fixture, settings-panel side)
    const errors = validateSubset(report, V1_SCHEMA);
    expect(errors.map((e) => `${e.path}: ${e.message}`).join("\n")).toBe("");
    // and the panel renders the bumped report the way it renders any report:
    // surface rows verbatim, verdict chips verbatim, no crash on components
    const html = renderFleetSection(report as DoctorReport);
    expect(html).toContain("agent-cards-global");
    expect(html).toContain("current");
    const cards = (report as { surfaces: { surface: string; components?: unknown[] }[] }).surfaces
      .find((s) => s.surface === "agent-cards-global")!;
    expect(cards.components!.length).toBeGreaterThan(0); // the fixture exercises the tolerance
  });
});

// ─── renderFleetSection: doctor's facts, verbatim (AC1) ──────────────────────

describe("fleet panel — renderFleetSection renders doctor's report verbatim", () => {
  for (const name of FIXTURE_NAMES) {
    it(`${name}: every surface name, version, source version, and verdict chip appears exactly as doctor said`, () => {
      const report = fixture(name) as unknown as DoctorReport;
      const html = renderFleetSection(report);
      for (const s of report.surfaces) {
        expect(html, `surface name for ${s.surface}`).toContain(s.surface);
        // null renders as the honest absence marker "—" — the same marker
        // doctor's own human table uses for null version fields.
        expect(html, `version for ${s.surface}`).toContain(s.version ?? "—");
        expect(html, `source version for ${s.surface}`).toContain(s.source_version ?? "—");
        // the chip TEXT is the verdict string itself, verbatim
        expect(html, `verdict chip for ${s.surface}`).toContain(`>${s.verdict}<`);
      }
    });
  }

  it("evidence lines render verbatim (the row's diagnosis, as doctor wrote it)", () => {
    const report = fixture("doctor-integrity-failure.json") as unknown as DoctorReport;
    const html = renderFleetSection(report);
    const serverBinary = report.surfaces[0]!;
    for (const line of serverBinary.evidence) {
      expect(html).toContain(line);
    }
  });
});

// ─── upgrade control enabled-state derives from the verdict ONLY (AC2) ──────

describe("fleet panel — upgrade control enabled-state derives from the verdict chip", () => {
  it("current fixture: every upgrade control carries the disabled property", () => {
    const report = fixture("doctor-current.json") as unknown as DoctorReport;
    const html = renderFleetSection(report);
    for (const s of report.surfaces) {
      const btn = upgradeButtonFor(html, s.surface);
      expect(isDisabled(btn), `${s.surface} (verdict ${s.verdict}) must be disabled`).toBe(true);
    }
  });

  it("stale fixture: ONLY the stale surface's upgrade control is enabled (disabled property false)", () => {
    const report = fixture("doctor-stale.json") as unknown as DoctorReport;
    const html = renderFleetSection(report);
    for (const s of report.surfaces) {
      const btn = upgradeButtonFor(html, s.surface);
      expect(isDisabled(btn), `${s.surface} (verdict ${s.verdict})`).toBe(s.verdict !== "stale");
    }
  });

  it("integrity-failure fixture: the integrity-failure control is enabled; the unknown control is disabled", () => {
    const report = fixture("doctor-integrity-failure.json") as unknown as DoctorReport;
    const html = renderFleetSection(report);
    const byVerdict = new Map(report.surfaces.map((s) => [s.verdict, s.surface]));
    const failing = byVerdict.get("integrity-failure")!;
    const unknown = byVerdict.get("unknown")!;
    expect(isDisabled(upgradeButtonFor(html, failing))).toBe(false);
    expect(isDisabled(upgradeButtonFor(html, unknown))).toBe(true);
  });

  it("the enabled-state rule is exactly: stale OR integrity-failure (view logic, nothing else)", () => {
    expect(upgradeEnabled("stale")).toBe(true);
    expect(upgradeEnabled("integrity-failure")).toBe(true);
    expect(upgradeEnabled("current")).toBe(false);
    expect(upgradeEnabled("unknown")).toBe(false);
  });
});

// ─── zero version/staleness logic in the panel (AC5) ─────────────────────────

describe("fleet panel — zero version logic: the verdict chip comes from doctor, full stop", () => {
  it("a report whose version strings DISAGREE with its verdict still renders the verdict and derives nothing from the versions", () => {
    // Doctor says current while the version strings look "behind" — and says
    // stale while they look "equal". A panel carrying any version comparison
    // (or normalizing version strings) flips these. The report is the truth.
    const report: DoctorReport = {
      surfaces: [
        {
          surface: "extension",
          version: "0.1.0-not-a-version",
          source_version: "9.9.9",
          verdict: "current",
          evidence: ["doctor said so"],
        },
        {
          surface: "vendored-binary",
          version: "1.2.3",
          source_version: "1.2.3",
          verdict: "stale",
          evidence: ["doctor said so"],
        },
        {
          surface: "server-binary",
          version: "<script>",
          source_version: "&garbage",
          verdict: "integrity-failure",
          evidence: ["hostile string: <b>not bold</b>"],
        },
        {
          surface: "staged-skills",
          version: null,
          source_version: null,
          verdict: "unknown",
          evidence: ["no source of truth"],
        },
        {
          surface: "agent-cards-global",
          version: "sha256:aaa",
          source_version: "sha256:bbb",
          verdict: "stale",
          evidence: ["digest drift"],
        },
        {
          surface: "agent-cards-staging",
          version: "sha256:aaa",
          source_version: "sha256:bbb",
          verdict: "current",
          evidence: ["digest match"],
        },
      ],
    };
    const html = renderFleetSection(report);

    // verbatim, un-normalized, un-compared: the raw strings appear as data
    // (script-tag content is ESCAPED as markup — verbatim as *text*)
    expect(html).toContain("0.1.0-not-a-version");
    expect(html).toContain("9.9.9");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;garbage");
    // the chips say what doctor said, never what a comparison would say
    expect(html).toContain(">current<");
    expect(html).toContain(">stale<");
    expect(html).toContain(">integrity-failure<");
    expect(html).toContain(">unknown<");
    // and the controls follow the chips, not the version strings:
    // "extension" (current, though 0.1.0 < 9.9.9) disabled…
    expect(isDisabled(upgradeButtonFor(html, "extension"))).toBe(true);
    // …"vendored-binary" (stale, though versions equal) enabled…
    expect(isDisabled(upgradeButtonFor(html, "vendored-binary"))).toBe(false);
    // …"server-binary" (integrity-failure) enabled…
    expect(isDisabled(upgradeButtonFor(html, "server-binary"))).toBe(false);
    // …"agent-cards-global" (stale, digests differ) enabled, while
    // "agent-cards-staging" (current, same digest pair) is disabled.
    expect(isDisabled(upgradeButtonFor(html, "agent-cards-global"))).toBe(false);
    expect(isDisabled(upgradeButtonFor(html, "agent-cards-staging"))).toBe(true);
  });
});

// ─── CLI invocation: the extension host spawns the verb (AC4) ────────────────

describe("fleet panel — CLI argv builders", () => {
  it("doctor argv is exactly [doctor, --json] — the machine contract", () => {
    expect(buildDoctorArgv()).toEqual(["doctor", "--json"]);
  });

  it("upgrade argv is the CLI verb + the surface argument, exactly as the report named it", () => {
    // no aliasing, no mapping — the surface string from doctor's JSON is the
    // argument (the verb router owns any name normalization, not the panel)
    expect(buildUpgradeArgv("extension")).toEqual(["upgrade", "extension"]);
    expect(buildUpgradeArgv("server-binary")).toEqual(["upgrade", "server-binary"]);
    expect(buildUpgradeArgv("agent-cards-global")).toEqual(["upgrade", "agent-cards-global"]);
  });
});

/** Build an injectable SpawnLike whose child emits the given stdout lines at
 *  attach time and defers `close`/`error` until the test fires it — so the
 *  promise under test observes the full lifecycle. */
function makeFakeSpawn(rec: { calls: Array<[string, string[]]> }) {
  let closeCb: ((code: number | null) => void) | undefined;
  let errorCb: ((err: Error) => void) | undefined;
  const stdoutLines: string[] = [];
  const spawnFn: SpawnLike = (cmd: string, args: string[]) => {
    rec.calls.push([cmd, args]);
    return {
      stdout: {
        on(event: string, listener: (chunk: string | Buffer) => void) {
          if (event === "data") for (const l of stdoutLines) listener(l);
        },
      },
      stderr: { on() {} },
      on(event: string, listener: (arg: never) => void) {
        if (event === "close") closeCb = listener as (code: number | null) => void;
        if (event === "error") errorCb = listener as (err: Error) => void;
      },
    };
  };
  return {
    spawnFn,
    stdoutLines,
    fireClose: (code: number | null) => closeCb?.(code),
    fireError: (err: Error) => errorCb?.(err),
  };
}

describe("fleet panel — runUpgrade spawns the verb, streams stdout, reads the receipt of record", () => {
  it("spawns the resolved amico binary with [upgrade, <surface>] and streams live stdout lines (receipt tailing seam)", async () => {
    const rec = { calls: [] as Array<[string, string[]]> };
    const fake = makeFakeSpawn(rec);
    fake.stdoutLines.push("pre-flight: doctor probe…\n", "executing…\nreceipt appended\n");
    const lines: string[] = [];
    const receiptsRead: string[] = [];
    const p = runUpgrade("staged-skills", {
      spawn: fake.spawnFn,
      amicoBin: "/opt/amico-launcher/amico",
      receiptsDir: "/receipts",
      onLine: (l) => lines.push(l),
      readLastReceipt: (dir, surface) => {
        receiptsRead.push(`${dir}|${surface}`);
        return { surface, outcome: "upgraded", verification: true };
      },
    });
    fake.fireClose(0);
    const result = await p;

    // the spawn: the CLI verb, the surface argument, via child_process seam
    expect(rec.calls).toEqual([["/opt/amico-launcher/amico", ["upgrade", "staged-skills"]]]);
    // the live stdout streamed, line by line
    expect(lines).toEqual(["pre-flight: doctor probe…", "executing…", "receipt appended"]);
    // the receipt store is the exit state of record — read AFTER the verb closes
    expect(receiptsRead).toEqual(["/receipts|staged-skills"]);
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.receipt).toEqual({ surface: "staged-skills", outcome: "upgraded", verification: true });
  });

  it("a non-zero exit still reads the receipt (aborted-* outcomes land in the store) and reports not-ok", async () => {
    const fake = makeFakeSpawn({ calls: [] });
    const p = runUpgrade("server-binary", {
      spawn: fake.spawnFn,
      readLastReceipt: () => ({ surface: "server-binary", outcome: "aborted-locked" }),
    });
    fake.fireClose(70);
    const result = await p;
    expect(result.ok).toBe(false);
    expect(result.code).toBe(70);
    expect(result.receipt).toEqual({ surface: "server-binary", outcome: "aborted-locked" });
  });

  it("a spawn failure (no amico binary) resolves not-ok and does NOT read the receipt store — no verb ran, so the store would only hold a STALE receipt", async () => {
    const fake = makeFakeSpawn({ calls: [] });
    let receiptReads = 0;
    const p = runUpgrade("extension", {
      spawn: fake.spawnFn,
      readLastReceipt: () => {
        receiptReads += 1;
        return { surface: "extension", outcome: "upgraded" };
      },
    });
    fake.fireError(new Error("spawn ENOENT"));
    const result = await p;
    expect(result.ok).toBe(false);
    expect(result.receipt).toBeNull();
    expect(receiptReads).toBe(0);
  });
});

describe("fleet panel — readLastReceipt (the JSONL store reader)", () => {
  const mk = (files: Record<string, string>) => ({
    readdir: () => Object.keys(files),
    readFile: (p: string) => {
      for (const [name, body] of Object.entries(files)) {
        if (p.endsWith(name)) return body;
      }
      throw new Error(`ENOENT ${p}`);
    },
  });

  it("returns the LAST receipt line naming the surface, scanning the store's JSONL files", () => {
    const deps = mk({
      "receipts.jsonl": [
        JSON.stringify({ surface: "extension", outcome: "upgraded", ts: "1" }),
        JSON.stringify({ surface: "extension", outcome: "no-op", ts: "2" }),
        JSON.stringify({ surface: "staged-skills", outcome: "upgraded", ts: "3" }),
      ].join("\n"),
    });
    const receipt = readLastReceipt("/receipts", "extension", deps);
    expect(receipt).toEqual({ surface: "extension", outcome: "no-op", ts: "2" });
  });

  it("returns null when the store is absent or empty (verbs not yet installed — honest, not a lie)", () => {
    expect(readLastReceipt("/receipts", "extension", mk({}))).toBeNull();
    const missing = {
      readdir: () => {
        throw new Error("ENOENT /receipts");
      },
      readFile: () => "",
    };
    expect(readLastReceipt("/receipts", "extension", missing)).toBeNull();
  });

  it("skips unparseable lines rather than failing the lookup", () => {
    const deps = mk({
      "receipts.jsonl": [
        "not json {",
        JSON.stringify({ surface: "extension", outcome: "restored" }),
      ].join("\n"),
    });
    expect(readLastReceipt("/receipts", "extension", deps)).toEqual({ surface: "extension", outcome: "restored" });
  });
});

describe("fleet panel — runDoctor spawns doctor --json and parses the report", () => {
  it("parses the report from the verb's stdout", async () => {
    const rec = { calls: [] as Array<[string, string[]]> };
    const fake = makeFakeSpawn(rec);
    fake.stdoutLines.push(JSON.stringify(fixture("doctor-current.json")));
    const p = runDoctor({ spawn: fake.spawnFn, amicoBin: "/opt/amico" });
    fake.fireClose(0);
    const result = await p;
    expect(rec.calls).toEqual([["/opt/amico", ["doctor", "--json"]]]);
    expect(result.ok).toBe(true);
    expect(result.report?.surfaces).toHaveLength(6);
  });

  it("a non-JSON or surfaces-less stdout is an error, never a crash", async () => {
    const fake = makeFakeSpawn({ calls: [] });
    fake.stdoutLines.push("studio binding healthy\n(no --json today)\n");
    const p = runDoctor({ spawn: fake.spawnFn });
    fake.fireClose(0);
    const result = await p;
    expect(result.ok).toBe(false);
    expect(result.report).toBeNull();
    expect(result.error).toBeTruthy();
  });
});

// ─── the standalone webview panel is RETIRED (#1322, AC5) ────────────────────
// The Fleet & Versions panel is absorbed into the Fleet Manager Work Column tab.
// registerFleetPanel no longer registers a command or opens a panel; the pure
// primitives above (renderFleetSection / runDoctor / upgradeEnabled / …) remain
// the Versions CONTENT, now shipped to the tab by registerFleetManagerCommands.

const okDoctor = (name: (typeof FIXTURE_NAMES)[number]): (() => Promise<DoctorOutcome>) =>
  async () => ({ ok: true, report: fixture(name) as unknown as DoctorReport, error: null });

const panelCtx = (): { subscriptions: unknown[]; extensionUri: unknown } => ({
  subscriptions: [],
  extensionUri: vscode.Uri.file("/ext"),
});

describe("fleet panel — the standalone panel is retired", () => {
  beforeEach(() => {
    _resetFleetPanelForTesting();
  });

  it("registerFleetPanel no longer registers amicode.fleet.versions (it routes to the tab now)", () => {
    const spy = vi.spyOn(vscode.commands, "registerCommand");
    registerFleetPanel(panelCtx() as never, { doctor: vi.fn(okDoctor("doctor-current.json")) });
    expect(spy.mock.calls.map((c) => c[0])).not.toContain("amicode.fleet.versions");
    spy.mockRestore();
  });

  it("registerFleetPanel opens no webview panel", () => {
    const spy = vi.spyOn(vscode.window, "createWebviewPanel");
    registerFleetPanel(panelCtx() as never, { doctor: vi.fn(okDoctor("doctor-current.json")) });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
