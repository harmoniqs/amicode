// Tests for the campaign-ledger section parser + the campaign routes
// (GET /amicode/campaigns, GET /amicode/campaign — issue #658).
//
// campaign_ledger.ts uses node: builtins only (fs/path) — the amicode_service
// sibling rule (stack_state.ts neighborhood). Fixtures are TRIMMED REAL
// ledgers from the personal vault's sessions/ dir (fixtures/campaign/):
// a clean 9-section one and the §9-straddled one (loop-log rows appended
// after the §9 header — append-at-EOF straddle, verified in the wild).
// Route-level tests point the personal vault at a fresh temp dir via
// AMICO_VAULTS_ROOT so nothing touches the real ~/.amico.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { campaignBody, campaignsBody, parseLedger } from "../src/amicode_service/campaign_ledger";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/campaign/${name}`, import.meta.url));

describe("parseLedger — clean fixture (real trimmed strumento-twins ledger)", () => {
  const text = fs.readFileSync(fixture("session-20260830-strumento-twins-bringup.trimmed.md"), "utf8");
  const parsed = parseLedger(text);

  it("parses the frontmatter scalars (quotes stripped, arrays kept raw)", () => {
    expect(parsed.frontmatter.type).toBe("session-ledger");
    expect(parsed.frontmatter.date).toBe("2026-08-30");
    expect(parsed.frontmatter.campaign).toBe("strumento-twins-bringup");
    expect(parsed.frontmatter.status).toBe("ACTIVE");
  });

  it("finds the nine canonical sections", () => {
    expect(parsed.sectionsFound).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("carries the §1 objective (full section body, trimmed)", () => {
    expect(parsed.objective).toContain("make **Strumento.jl the substrate**");
    expect(parsed.objective).not.toContain("## 2.");
  });

  it("parses §2's verdict table rows (header kept, separator dropped)", () => {
    expect(parsed.verdicts).toHaveLength(3); // header + S1 + S2
    expect(parsed.verdicts[0]).toEqual(["slice", "repo", "content", "status"]);
    expect(parsed.verdicts[1]![0]).toBe("S1");
    expect(parsed.verdicts[2]![0]).toBe("S2");
    expect(parsed.verdicts[1]!.join(" ")).toContain("PR #17 squash-merged @ 3e94ae4");
  });

  it("carries §3/§4/§5 as structured text", () => {
    expect(parsed.activeWork).toContain("L1-impl-14");
    expect(parsed.blocked).toContain("**S2** blocked by S1 merged");
    expect(parsed.nextQueue).toContain("casts **IN FLIGHT**");
    expect(parsed.blocked).not.toContain("## 5.");
  });

  it("carries §9's compaction state", () => {
    expect(parsed.compaction).toContain("(none — append one row per compaction");
  });
});

describe("parseLedger — loop-log tail window (documented bound: last 10 table rows)", () => {
  it("bounds a long §8 table to the last 10 rows, order preserved", () => {
    const rows = Array.from({ length: 14 }, (_, i) => `| ${i} | 2026-08-30 | unit ${i} | done | artifacts |`).join("\n");
    const text = `# L\n\n## 8. Loop log\n\n| loop | date | unit | verdict | artifacts |\n|---|---|---|---|---|\n${rows}\n`;
    const parsed = parseLedger(text);
    const tailRows = parsed.loopLogTail.split("\n");
    expect(tailRows).toHaveLength(10);
    expect(tailRows[0]).toContain("| 4 |"); // first kept row = row 4 of 0..13
    expect(tailRows[9]).toContain("| 13 |"); // the newest row survives
    expect(parsed.loopLogTail).not.toContain("unit 3 ");
  });

  it("falls back to the last 40 non-empty lines when §8 is not a table", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `- loop ${i} note`).join("\n");
    const text = `# L\n\n## 8. Loop log\n\n${lines}\n`;
    const parsed = parseLedger(text);
    const tailLines = parsed.loopLogTail.split("\n");
    expect(tailLines).toHaveLength(40);
    expect(tailLines[0]).toContain("loop 10");
    expect(tailLines[39]).toContain("loop 49");
  });
});

describe("parseLedger — §9 straddle (real trimmed hrl-8dot ledger; loop rows appended after §9)", () => {
  const text = fs.readFileSync(fixture("session-20260820-hrl-8dot-spin-mintime.straddle.md"), "utf8");
  const parsed = parseLedger(text);

  it("keeps the §2 hypothesis table (title variant 'Hypothesis ledger')", () => {
    expect(parsed.verdicts).toHaveLength(2); // header + H2
    expect(parsed.verdicts[1]![0]).toBe("H2");
    expect(parsed.verdicts[1]!.join(" ")).toContain("REFUTED (inverted)");
  });

  it("recovers the straddled loop rows into §8's log — none lost to compaction", () => {
    // §8 proper had header + 2 rows; 2 more data rows were appended after §9's
    // header at EOF. The window keeps all 5 (bound is 10).
    const tailRows = parsed.loopLogTail.split("\n");
    expect(tailRows).toHaveLength(5);
    expect(tailRows[0]).toContain("| date | H# |"); // §8's own header row first
    // The straddled rows are the pass-3 amendment and the fast-calibration rows.
    expect(parsed.loopLogTail).toContain("pass-3 amendment");
    expect(parsed.loopLogTail).toContain("spec-20260820-hrl-spin-cz-fast-calibration");
    // …and the newest straddled row is the tail's last row (chronology kept).
    expect(tailRows[4]).toContain("spec-20260820-hrl-spin-cz-fast-calibration");
  });

  it("leaves §9's own (non-table) compaction content in compaction", () => {
    expect(parsed.compaction).toContain("(append-only: timestamp, auto/manual");
    expect(parsed.compaction).not.toContain("pass-3 amendment");
    expect(parsed.compaction).not.toContain("|");
  });
});

describe("campaignsBody — GET /amicode/campaigns (list, newest first)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amicode-campaigns-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const writeLedger = (name: string, text: string): void => {
    fs.mkdirSync(path.join(tmp, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "sessions", name), text);
  };

  it("lists session-*.md files newest-first with frontmatter + §1 objective line", () => {
    writeLedger(
      "session-20260820-hrl.md",
      fs.readFileSync(fixture("session-20260820-hrl-8dot-spin-mintime.straddle.md"), "utf8"),
    );
    writeLedger(
      "session-20260830-twins.md",
      fs.readFileSync(fixture("session-20260830-strumento-twins-bringup.trimmed.md"), "utf8"),
    );
    const body = JSON.parse(campaignsBody(path.join(tmp, "sessions")));
    expect(body.ok).toBe(true);
    expect(body.error).toBeNull();
    expect(body.campaigns.map((c: any) => c.slug)).toEqual(["session-20260830-twins", "session-20260820-hrl"]);
    const twins = body.campaigns[0];
    expect(twins).toMatchObject({
      slug: "session-20260830-twins",
      date: "2026-08-30",
      campaign: "strumento-twins-bringup",
      status: "ACTIVE",
      type: "session-ledger",
    });
    expect(twins.objective).toContain("Execute the 2026-08-30 plan-of-record");
    // the hrl ledger is type: session with a label, not a campaign name
    expect(body.campaigns[1]).toMatchObject({ date: "2026-08-20", status: "active", campaign: "hrl-8dot-spin-mintime" });
  });

  it("degrades on a frontmatter-less ledger (nulls, date falls back to the filename) and skips non-ledger files", () => {
    writeLedger(
      "session-20260830-skill-health.md",
      "# Session ledger — skill health\n\n## 1. Objective & standing directives\n\n- User directives (2026-08-29 night): test everything.\n",
    );
    writeLedger("CHECKOUTS.md", "# Checkouts\n");
    writeLedger("notes.md", "not a ledger");
    const body = JSON.parse(campaignsBody(path.join(tmp, "sessions")));
    expect(body.ok).toBe(true);
    expect(body.campaigns).toHaveLength(1);
    expect(body.campaigns[0]).toMatchObject({
      slug: "session-20260830-skill-health",
      date: "2026-08-30", // filename fallback — the file has no frontmatter
      campaign: null,
      status: null,
      type: null,
    });
    expect(body.campaigns[0].objective).toContain("User directives (2026-08-29 night)");
  });

  it("degrades on malformed frontmatter (unterminated block) — degraded entry, not an error", () => {
    writeLedger(
      "session-20260827-broken.md",
      "---\ntype: session-ledger\ndate: 2026-08-27\n# no closing fence\n\n## 1. Objective\n\nShip it.\n",
    );
    const body = JSON.parse(campaignsBody(path.join(tmp, "sessions")));
    expect(body.ok).toBe(true);
    expect(body.campaigns).toHaveLength(1);
    expect(body.campaigns[0].type).toBeNull();
  });

  it("returns an empty list for an empty sessions dir and for a missing dir — never an error shape", () => {
    fs.mkdirSync(path.join(tmp, "sessions"), { recursive: true });
    expect(JSON.parse(campaignsBody(path.join(tmp, "sessions")))).toEqual({ ok: true, campaigns: [], error: null });
    expect(JSON.parse(campaignsBody(path.join(tmp, "nope")))).toEqual({ ok: true, campaigns: [], error: null });
    expect(JSON.parse(campaignsBody(undefined))).toEqual({ ok: true, campaigns: [], error: null });
  });
});

describe("campaignBody — GET /amicode/campaign?slug=… (one ledger, structured sections)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amicode-campaign-"));
    fs.mkdirSync(path.join(tmp, "sessions"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "sessions", "session-20260830-twins.md"),
      fs.readFileSync(fixture("session-20260830-strumento-twins-bringup.trimmed.md"), "utf8"),
    );
    fs.writeFileSync(
      path.join(tmp, "sessions", "session-20260820-hrl.md"),
      fs.readFileSync(fixture("session-20260820-hrl-8dot-spin-mintime.straddle.md"), "utf8"),
    );
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the ledger's structured sections (wire snake_case)", () => {
    const body = JSON.parse(campaignBody(path.join(tmp, "sessions"), "session-20260830-twins"));
    expect(body.ok).toBe(true);
    expect(body.error).toBeNull();
    const c = body.campaign;
    expect(c.slug).toBe("session-20260830-twins");
    expect(c.date).toBe("2026-08-30");
    expect(c.campaign).toBe("strumento-twins-bringup");
    expect(c.status).toBe("ACTIVE");
    expect(c.type).toBe("session-ledger");
    expect(c.objective).toContain("make **Strumento.jl the substrate**");
    expect(c.verdicts).toHaveLength(3);
    expect(c.verdicts[0]).toEqual(["slice", "repo", "content", "status"]);
    expect(c.active_work).toContain("L1-impl-14");
    expect(c.blocked).toContain("**S2** blocked by S1 merged");
    expect(c.next_queue).toContain("casts **IN FLIGHT**");
    expect(c.loop_log_tail.split("\n")).toHaveLength(3); // header + loop 0 + loop 1
    expect(c.compaction).toContain("(none — append one row per compaction");
    expect(c.sections_found).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(c.file_date).toBe("2026-08-30");
  });

  it("serves the straddled ledger with §8 extended to EOF (loop rows intact)", () => {
    const body = JSON.parse(campaignBody(path.join(tmp, "sessions"), "session-20260820-hrl"));
    const c = body.campaign;
    expect(c.loop_log_tail.split("\n")).toHaveLength(5);
    expect(c.loop_log_tail).toContain("pass-3 amendment");
    expect(c.compaction).not.toContain("|");
    expect(c.date).toBe("2026-08-20");
    expect(c.campaign).toBe("hrl-8dot-spin-mintime"); // label fallback
  });

  it("404-shapes an unknown slug (ok:false not_found, HTTP-200 body — the problems.ts convention)", () => {
    const body = JSON.parse(campaignBody(path.join(tmp, "sessions"), "session-19990101-nope"));
    expect(body.ok).toBe(false);
    expect(body.error).toContain("not_found:session-19990101-nope");
    expect(body.campaign).toBeUndefined();
  });

  it("bad-requests a missing slug", () => {
    const body = JSON.parse(campaignBody(path.join(tmp, "sessions"), undefined));
    expect(body.ok).toBe(false);
    expect(body.error).toContain("bad_request");
  });

  it("refuses a slug that would traverse out of the sessions dir", () => {
    for (const evil of ["..%2F..%2Fvault", "session-../../secret", "..", "session-../x"]) {
      const body = JSON.parse(campaignBody(path.join(tmp, "sessions"), evil));
      expect(body.ok).toBe(false);
      expect(body.error).not.toContain("ok\":true");
    }
    // the guarded read never escaped: no file outside sessions/ was consulted
    expect(fs.existsSync(path.join(tmp, "secret"))).toBe(false);
  });

  it("degrades a missing dir to not_found for the asked slug", () => {
    const body = JSON.parse(campaignBody(path.join(tmp, "nope"), "session-20260830-twins"));
    expect(body.ok).toBe(false);
    expect(body.error).toContain("not_found:");
  });
});

describe("degradation — missing sections, junk in the dir, never a 500 (issue #658 AC)", () => {
  it("missing §4/§5 degrade to empty strings; sectionsFound reflects what exists", () => {
    const text = [
      "---",
      "type: session-ledger",
      "date: 2026-08-26",
      "campaign: no-queue-ledger",
      "status: ACTIVE",
      "---",
      "",
      "# L",
      "",
      "## 1. Objective",
      "",
      "Do the thing.",
      "",
      "## 2. Verdict table",
      "",
      "| unit | status | evidence |",
      "|---|---|---|",
      "| U1 | DONE | ran it |",
      "",
      "## 8. Loop log",
      "",
      "| loop | verdict |",
      "|---|---|",
      "| 0 | started |",
      "",
      "## 9. Compaction log",
      "",
      "(empty)",
      "",
    ].join("\n");
    const parsed = parseLedger(text);
    expect(parsed.blocked).toBe("");
    expect(parsed.nextQueue).toBe("");
    expect(parsed.activeWork).toBe("");
    expect(parsed.verdicts).toHaveLength(2);
    expect(parsed.sectionsFound).toEqual([1, 2, 8, 9]);
    expect(parsed.loopLogTail).toContain("| 0 | started |");
  });

  it("a directory named like a ledger (or any unreadable entry) is skipped by the list", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amicode-campaign-junk-"));
    try {
      const sessions = path.join(tmp, "sessions");
      fs.mkdirSync(path.join(sessions, "session-20260826-actually-a-dir.md"), { recursive: true });
      fs.writeFileSync(path.join(sessions, "session-20260825-fine.md"), "# L\n\n## 1. Objective\n\nFine.\n");
      const body = JSON.parse(campaignsBody(sessions));
      expect(body.ok).toBe(true);
      expect(body.campaigns.map((c: any) => c.slug)).toEqual(["session-20260825-fine"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
