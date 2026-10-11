// `amico extract-meetings` (amicode #1686, brain flywheel slice 7 — the meeting
// intake half): given a pending-tag meeting note, propose its three tag tiers
// (populated per the vault registry's closed vocabularies, gaps named, never
// invented), a context-links section with resolvable links, and next-steps →
// hopper proposals with meeting provenance. Dry-run by default; --apply writes
// PROPOSALS into a --out the caller names (the meeting vault itself is never
// written — read-only substrate). Idempotent: deterministic naming + bytes, a
// re-run overwrites its own outputs and moves nothing. The notturno pass receipt
// rides the same chassis gates as distill (deny-list, job membership,
// record-mode self-filter). Hermetic: fixture meeting vault + fake mount stacks.
//
// Run: `pnpm --filter @amicode/amico-run test triage`
import { describe, it, expect } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractMeetingsVerb } from "../src/extract_meetings_verb.js";
import { SPINE_VERBS } from "../src/verbs.js";
import { parseFrontmatter } from "../src/frontmatter.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "triage");
const MEETING_VAULT = join(FIXTURES, "meeting-vault");
const NOTES = join(MEETING_VAULT, "notes", "2026", "08");
const QICK = join(NOTES, "2026-08-24-qick-harmoniqs-calqick1_20260824T200000Z.md");

/** A fixture notturno registry with the extract-meetings job registered. */
function jobRegistry(dir: string, record: "always" | "acted" = "always", name = "registry.toml"): string {
  const p = join(dir, name);
  writeFileSync(
    p,
    [
      `[job.extract-meetings]`,
      `workflow = "notturno-extract-meetings.yml"`,
      `cadence  = "0 12 * * 1"`,
      `surface  = "mini"`,
      `warrant  = "stage"`,
      `delivers = ["vault-commit"]`,
      `record   = "${record}"`,
      `enabled  = true`,
      "",
    ].join("\n"),
  );
  return p;
}

/** A fake vault root with a personal mount + the meeting vault, both marked. */
function fakeStack(): { root: string; personal: string; meetings: string } {
  const root = mkdtempSync(join(tmpdir(), "triage-stack-"));
  const personal = join(root, "vault-aaron");
  const meetings = join(root, "meeting-vault");
  mkdirSync(join(personal, "amicode"), { recursive: true });
  writeFileSync(join(personal, ".amico-vault.toml"), 'kind = "personal"\nname = "vault-aaron"\n');
  cpSync(MEETING_VAULT, meetings, { recursive: true });
  writeFileSync(join(meetings, ".amico-vault.toml"), 'kind = "team"\nname = "meeting-vault"\n');
  return { root, personal, meetings };
}

describe("amico extract-meetings — usage + resolution", () => {
  it("no note / unknown flag → usage error, exit 64", async () => {
    expect((await extractMeetingsVerb([], {})).code).toBe(64);
    expect((await extractMeetingsVerb(["--frob"], {})).code).toBe(64);
    const usage = ((await extractMeetingsVerb([], {})).json as { usage: string }).usage;
    expect(usage).toContain("amico extract-meetings");
  });

  it("a missing note or a missing meeting vault is an honest 64, never a guess", async () => {
    const none = { AMICO_VAULTS_ROOT: join(tmpdir(), "triage-no-such-root") };
    expect((await extractMeetingsVerb([join(NOTES, "nope.md")], none)).code).toBe(64);
    expect((await extractMeetingsVerb([QICK], none)).code).toBe(64); // no mount stack resolves meeting-vault
    const j = (await extractMeetingsVerb([QICK], none)).json as { error: string };
    expect(j.error).toContain("--meetings");
  });

  it("is in SPINE_VERBS with the fields Verb requires", () => {
    const verb = SPINE_VERBS.find((v) => v.name === "extract-meetings");
    expect(verb).toBeDefined();
    expect(verb!.summary.length).toBeGreaterThan(0);
    expect(verb!.generalizes.length).toBeGreaterThan(0);
    expect(verb!.slice.length).toBeGreaterThan(0);
  });
});

describe("amico extract-meetings — the dry-run default (proposals, never writes)", () => {
  it("reports tags/gaps/steps/context links and writes NOTHING (no --out tree, no receipt)", async () => {
    const out = mkdtempSync(join(tmpdir(), "triage-out-"));
    const r = await extractMeetingsVerb([QICK, "--meetings", MEETING_VAULT, "--out", out], {});
    expect(r.code).toBe(0);
    const j = r.json as Record<string, unknown>;
    expect(j.dry_run).toBe(true);
    expect(j.status).toBe("pending-tag");
    const tags = j.tags as Record<string, string[]>;
    expect(tags.entities).toContain("partner:alice-and-bob");
    expect((j.gaps as string[]).some((g) => g.includes("recurring external"))).toBe(true);
    expect(j.steps).toBe(3);
    expect((j.context_links as string[]).length).toBeGreaterThan(0);
    expect((j.receipt as Record<string, unknown>).filed).toBe(false);
    expect(existsSync(join(out, "meetings"))).toBe(false);
    expect(existsSync(join(out, "hopper"))).toBe(false);
  });

  it("an already-tagged note (status: complete) is an honest no-op, exit 0", async () => {
    const out = mkdtempSync(join(tmpdir(), "triage-out-"));
    const r = await extractMeetingsVerb([
      join(NOTES, "2026-08-21-already-done-caldone1_20260821T170000Z.md"),
      "--meetings",
      MEETING_VAULT,
      "--out",
      out,
    ], {});
    expect(r.code).toBe(0);
    const j = r.json as Record<string, unknown>;
    expect(j.skipped).toBeDefined();
    expect(j.steps).toBe(0);
    expect(existsSync(join(out, "meetings"))).toBe(false);
  });
});

describe("amico extract-meetings — apply: proposals land, idempotently", () => {
  it("writes the tagged-note proposal + one hopper proposal per next step, all with provenance", async () => {
    const out = mkdtempSync(join(tmpdir(), "triage-out-"));
    const r = await extractMeetingsVerb([QICK, "--meetings", MEETING_VAULT, "--out", out, "--apply"], {});
    expect(r.code).toBe(0);
    const j = r.json as Record<string, unknown>;
    expect(j.dry_run).toBe(false);

    const noteProposal = join(out, "meetings", basename(QICK));
    expect(existsSync(noteProposal)).toBe(true);
    const proposed = readFileSync(noteProposal, "utf8");
    expect(proposed).toContain("status: complete");
    expect(proposed).toContain('partner:alice-and-bob');
    expect(proposed).toContain("## Context Links");
    expect(proposed).not.toContain("(auto-linked at curation)");
    // the note's own prose is preserved verbatim
    expect(proposed).toContain("**Pursuit of Alice and Bob partnership**");

    const hopperDir = join(out, "hopper");
    const hopperFiles = readdirSync(hopperDir).sort();
    expect(hopperFiles).toHaveLength(3);
    expect(hopperFiles[0]).toBe("hopper-20260824-qick-harmoniqs-calqick1-01.md");
    const fm = parseFrontmatter(readFileSync(join(hopperDir, hopperFiles[0]!), "utf8"));
    if (!fm.ok) throw new Error(fm.error);
    expect(fm.data.provenance).toBe(`meeting-note/notes/2026/08/${basename(QICK)}`);
    expect(fm.data.owner).toBe("Jack Champagne");
  });

  it("IDEMPOTENT: re-run overwrites its own outputs with identical bytes — no duplicates, no drift", async () => {
    const out = mkdtempSync(join(tmpdir(), "triage-out-"));
    await extractMeetingsVerb([QICK, "--meetings", MEETING_VAULT, "--out", out, "--apply"], {});
    const snapshot = (dir: string) =>
      readdirSync(dir)
        .sort()
        .map((f) => [f, readFileSync(join(dir, f), "utf8")] as const)
        .map(([f, t]) => `${f}\n${t}`)
        .join("\n--\n");
    const afterFirst = snapshot(join(out, "meetings")) + "\n--\n" + snapshot(join(out, "hopper"));
    const r2 = await extractMeetingsVerb([QICK, "--meetings", MEETING_VAULT, "--out", out, "--apply"], {});
    expect(r2.code).toBe(0);
    const afterSecond = snapshot(join(out, "meetings")) + "\n--\n" + snapshot(join(out, "hopper"));
    expect(afterSecond).toBe(afterFirst);
    expect(readdirSync(join(out, "hopper"))).toHaveLength(3);
  });
});

describe("amico extract-meetings — default resolution through the mount stack", () => {
  it("the meeting vault resolves by its mount name; --out defaults to the personal mount's amicode/triage area", async () => {
    const { root, personal, meetings } = fakeStack();
    const note = join(meetings, "notes", "2026", "08", basename(QICK));
    const r = await extractMeetingsVerb([note], { AMICO_VAULTS_ROOT: root });
    expect(r.code).toBe(0);
    const j = r.json as Record<string, unknown>;
    expect(j.meetings_root).toBe(meetings);
    expect((j.would_write as Record<string, unknown>).note).toBe(join(personal, "amicode", "triage", "meetings", basename(QICK)));
  });
});

describe("amico extract-meetings — the notturno pass receipt (the distill chassis gates)", () => {
  it("apply + --registry/--dashboards files the receipt with the job's outcome line", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "triage-receipt-"));
    const registry = jobRegistry(tmp);
    const dashboards = join(tmp, "dashboards");
    const r = await extractMeetingsVerb([QICK, "--meetings", MEETING_VAULT, "--out", join(tmp, "out"), "--apply", "--registry", registry, "--dashboards", dashboards], {});
    expect(r.code).toBe(0);
    const journal = readFileSync(join(dashboards, "scheduled-passes.md"), "utf8");
    expect(journal).toContain("## Pass ");
    expect(journal).toContain("extract-meetings");
    expect(journal).toContain("proposed 3 hopper");
    expect(((r.json as Record<string, unknown>).receipt as Record<string, unknown>).filed).toBe(true);
  });

  it("an unregistered job id is refused: exit 2, no receipt file", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "triage-receipt-"));
    const registry = join(tmp, "other.toml");
    writeFileSync(registry, '[job.other]\nworkflow = "w.yml"\ncadence = "* * *"\nsurface = "mini"\nwarrant = "stage"\nenabled = false\n');
    const dashboards = join(tmp, "dashboards");
    const r = await extractMeetingsVerb([QICK, "--meetings", MEETING_VAULT, "--out", join(tmp, "out"), "--apply", "--registry", registry, "--dashboards", dashboards], {});
    expect(r.code).toBe(2);
    expect(existsSync(join(dashboards, "scheduled-passes.md"))).toBe(false);
  });

  it("a deny-listed registry is refused loudly (exit 64) — org config never runs through the public verb", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "triage-deny-"));
    const registry = jobRegistry(tmp, "always", "notturno.toml");
    writeFileSync(
      join(tmp, "instance-deny-list.toml"),
      '[[deny]]\npath = "notturno.toml"\nreason = "instance config"\n',
    );
    const r = await extractMeetingsVerb([QICK, "--meetings", MEETING_VAULT, "--out", join(tmp, "out"), "--apply", "--registry", registry, "--dashboards", join(tmp, "dashboards")], {});
    expect(r.code).toBe(64);
    const j = r.json as { error: string };
    expect(j.error).toContain("deny list");
  });

  it("record: acted + a pass that proposed nothing honestly skips the receipt", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "triage-acted-"));
    const registry = jobRegistry(tmp, "acted");
    const dashboards = join(tmp, "dashboards");
    // a note with no attendees, no next steps, no title signals, no transcript, single occurrence
    const bare = join(tmp, "meetings", "notes");
    mkdirSync(bare, { recursive: true });
    writeFileSync(
      join(bare, "2026-08-22-bare-cal_20260822T120000Z.md"),
      [
        "---",
        "type: meeting",
        'title: "Weekly sync"',
        "date: 2026-08-22",
        "attendees: []",
        "tags:",
        "  products: []",
        "  projects: []",
        "  entities: []",
        "  types: []",
        "  themes: []",
        "unresolved: []",
        "event_id: cal_20260822T120000Z",
        "status: pending-tag",
        "---",
        "",
        "## Context Links",
        "- (auto-linked at curation)",
        "",
        "## Notes (curated)",
        "### Summary",
        "",
        "Nothing proposed here.",
        "",
      ].join("\n"),
    );
    const r = await extractMeetingsVerb([join(bare, "2026-08-22-bare-cal_20260822T120000Z.md"), "--meetings", join(tmp, "meetings"), "--out", join(tmp, "out"), "--apply", "--registry", registry, "--dashboards", dashboards], {});
    expect(r.code).toBe(0);
    expect(existsSync(join(dashboards, "scheduled-passes.md"))).toBe(false);
    const receipt = (r.json as Record<string, unknown>).receipt as Record<string, unknown>;
    expect(receipt.filed).toBe(false);
    expect(String(receipt.reason)).toContain("action only");
  });

  it("--registry without --dashboards is a usage error (the receipt needs its journal)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "triage-receipt-"));
    const r = await extractMeetingsVerb([QICK, "--meetings", MEETING_VAULT, "--out", join(tmp, "out"), "--apply", "--registry", jobRegistry(tmp)], {});
    expect(r.code).toBe(64);
  });
});
