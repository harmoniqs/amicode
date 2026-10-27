// `amico spec slices` — file a spec's Plan rows as linked issues (rd-system v2.1 A0a, #1900).
//
// Every GitHub interaction rides the injected `SlicesGh` layer (or the injected `gh api`
// runner beneath it); nothing here touches the network.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { designHash } from "@amicode/schema";
import { TASK_TYPES } from "../src/ledger.js";
import { parseFrontmatter } from "../src/frontmatter.js";
import { specVerb } from "../src/spec_verb.js";
import { callMcpTool } from "../src/mcp_serve.js";
import {
  PlanTableError,
  fileSlices,
  ghApiSlices,
  parseAdoption,
  parsePlanTable,
  parseProvenance,
  provenanceMarker,
  type GhApiRunner,
  type GhIssue,
  type IssueAddr,
  type SlicesGh,
} from "../src/spec_slices.js";

const here = dirname(fileURLToPath(import.meta.url));
const REAL_SPEC = join(here, "../../../config/specs/spec-20261026-101500-rd-system-v2-1.md");
const realRaw = readFileSync(REAL_SPEC, "utf8");

/** In-memory GitHub: issues per repo, sub-issue and blocked-by edges keyed by numeric id.
 *  `calls` counts every method invocation so dry-run can assert ZERO. */
class FakeGh implements SlicesGh {
  calls: string[] = [];
  private nextId = 9_000_000;
  private nextNumber = new Map<string, number>();
  issues: Array<GhIssue & { title: string }> = [];
  subIssues = new Map<number, number[]>(); // parent id → child ids
  blockedBy = new Map<number, number[]>(); // issue id → blocker ids
  created = { issues: 0, subIssues: 0, blockedBy: 0 };
  edits = 0;

  seed(repo: string, number: number, body = "", state: "open" | "closed" = "open"): GhIssue {
    const i = { id: this.nextId++, number, repo, body, state, title: `seed ${number}` };
    this.issues.push(i);
    return i;
  }
  getIssue(addr: IssueAddr): GhIssue {
    this.calls.push(`getIssue ${addr.repo}#${addr.number}`);
    return { ...this.byAddr(addr) };
  }
  editIssueBody(addr: IssueAddr, body: string): void {
    this.calls.push(`editIssueBody ${addr.repo}#${addr.number}`);
    this.byAddr(addr).body = body;
    this.edits++;
  }
  private byAddr(a: IssueAddr) {
    const i = this.issues.find((x) => x.repo === a.repo && x.number === a.number);
    if (!i) throw new Error(`fake: no issue ${a.repo}#${a.number}`);
    return i;
  }
  findFiled(repo: string, specId: string): GhIssue[] {
    this.calls.push(`findFiled ${repo}`);
    return this.issues.filter((i) => i.repo === repo && (i.body ?? "").includes(specId));
  }
  createIssue(repo: string, title: string, body: string): GhIssue {
    this.calls.push(`createIssue ${repo}`);
    const n = (this.nextNumber.get(repo) ?? 100) + 1;
    this.nextNumber.set(repo, n);
    const i = { id: this.nextId++, number: n, repo, body, title };
    this.issues.push(i);
    this.created.issues++;
    return i;
  }
  listSubIssues(parent: IssueAddr): GhIssue[] {
    this.calls.push("listSubIssues");
    const ids = this.subIssues.get(this.byAddr(parent).id) ?? [];
    return this.issues.filter((i) => ids.includes(i.id));
  }
  addSubIssue(parent: IssueAddr, childId: number): void {
    this.calls.push("addSubIssue");
    const p = this.byAddr(parent).id;
    this.subIssues.set(p, [...(this.subIssues.get(p) ?? []), childId]);
    this.created.subIssues++;
  }
  listBlockedBy(issue: IssueAddr): GhIssue[] {
    this.calls.push("listBlockedBy");
    const ids = this.blockedBy.get(this.byAddr(issue).id) ?? [];
    return this.issues.filter((i) => ids.includes(i.id));
  }
  addBlockedBy(issue: IssueAddr, blockerId: number): void {
    this.calls.push("addBlockedBy");
    const p = this.byAddr(issue).id;
    this.blockedBy.set(p, [...(this.blockedBy.get(p) ?? []), blockerId]);
    this.created.blockedBy++;
  }
}

/** A trap layer: any call at all is a test failure. */
function trapGh(): SlicesGh & { calls: number } {
  const t = { calls: 0 } as SlicesGh & { calls: number };
  for (const m of ["findFiled", "createIssue", "getIssue", "editIssueBody", "listSubIssues", "addSubIssue", "listBlockedBy", "addBlockedBy"] as const) {
    (t as unknown as Record<string, unknown>)[m] = () => {
      t.calls++;
      throw new Error(`gh called during dry run: ${m}`);
    };
  }
  return t;
}

const TABLE_HEAD = "| # | tier | step | repo | task_type | after |\n|---|---|---|---|---|---|\n";
const mini = (rows: string, frontmatter = "spec_id: spec-mini") =>
  `---\nschema_version: "1"\n${frontmatter}\ntask_type: plan\nacceptance: ["x == 1"]\n---\n\n# t\n\n## Plan\n\nprose\n\n${TABLE_HEAD}${rows}\n## Non-goals\n\n- n\n`;

describe("parsePlanTable — the real v2.1 Plan table", () => {
  const steps = parsePlanTable(realRaw);

  it("parses all 50 rows into CompiledStep shape", () => {
    expect(steps).toHaveLength(50);
    expect(new Set(steps.map((s) => s.row)).size).toBe(50);
    for (const s of steps) {
      expect(s.id).toBe(String(s.row));
      expect((TASK_TYPES as readonly string[]).includes(s.task_type)).toBe(true);
      expect(typeof s.model).toBe("string");
    }
  });

  it("row 0 is this verb, with `—` meaning no `after`", () => {
    const r0 = steps.find((s) => s.row === 0)!;
    expect(r0).toMatchObject({ tier: 1, repo: "amicode", task_type: "implement-slice", title: "`amico spec slices` (A0a)" });
    expect(r0.needs).toBeUndefined();
  });

  it("multi-edge `after` becomes `needs` (row 20: 19, 7, 14, 34, 48; row 42: 1, 6, 34, 40)", () => {
    expect(steps.find((s) => s.row === 20)!.needs).toEqual(["19", "7", "14", "34", "48"]);
    expect(steps.find((s) => s.row === 42)!.needs).toEqual(["1", "6", "34", "40"]);
    expect(steps.find((s) => s.row === 2)!.needs).toEqual(["38"]);
  });

  it("keeps the table's row order (47 sits after 33; 46 is last) and cross-repo rows", () => {
    const order = steps.map((s) => s.row);
    expect(order.indexOf(47)).toBe(order.indexOf(33) + 1);
    expect(order[order.length - 1]).toBe(46);
    expect(steps.find((s) => s.row === 47)!.repo).toBe("aws-infra");
    expect(steps.find((s) => s.row === 22)!.repo).toBe("Telaio.jl");
  });

  it("53 blocked-by edges in total", () => {
    expect(steps.reduce((n, s) => n + (s.needs?.length ?? 0), 0)).toBe(53);
  });

  it("exactly one row adopts an existing issue: row 10 (`#1740 live skills`) → harmoniqs/amicode#1740 (#1949 §5)", () => {
    const adopting = steps.filter((s) => s.adopts);
    expect(adopting.map((s) => s.row)).toEqual([10]);
    expect(adopting[0].adopts).toEqual({ repo: "harmoniqs/amicode", number: 1740 });
    expect(adopting[0]).toMatchObject({ title: "#1740 live skills", repo: "amicode", tier: 2 });
    // rows whose FIRST reference is a bare mid-text `#N`, `(#N E2)`, or `repo #N` (spaced) file new issues
    for (const r of [11, 19, 21, 33, 37, 39, 46, 47]) expect(steps.find((s) => s.row === r)!.adopts).toBeUndefined();
  });
});

describe("parseAdoption — the step text's FIRST issue reference decides", () => {
  const a = (t: string, repo = "amicode") => parseAdoption(t, repo);
  it("`(#N)` adopts in the row's repo", () => {
    expect(a("wire the thing (#12)")).toEqual({ repo: "harmoniqs/amicode", number: 12 });
    expect(a("wire the thing (#12)", "arJev")).toEqual({ repo: "harmoniqs/arJev", number: 12 });
  });
  it("a leading `#N` (the step names the issue) adopts in the row's repo", () => {
    expect(a("#1740 live skills")).toEqual({ repo: "harmoniqs/amicode", number: 1740 });
  });
  it("`repo#N` adopts in harmoniqs/repo; `owner/repo#N` adopts verbatim", () => {
    expect(a("land aws-infra#322 fence")).toEqual({ repo: "harmoniqs/aws-infra", number: 322 });
    expect(a("land Telaio.jl#9 now")).toEqual({ repo: "harmoniqs/Telaio.jl", number: 9 });
    expect(a("port acme/widgets#7 here")).toEqual({ repo: "acme/widgets", number: 7 });
  });
  it("only the FIRST reference counts: a non-adopting first ref blocks a later adopting one", () => {
    expect(a("rebase #1678 then (#12)")).toBeUndefined();
    expect(a("thing (#12) then aws-infra#3")).toEqual({ repo: "harmoniqs/amicode", number: 12 });
  });
  it("bare mid-text `#N`, `(#N more)`, and spaced `repo #N` do not adopt", () => {
    expect(a("rebase + land #1678 corrections scan")).toBeUndefined();
    expect(a("implementer layer-skill loading (#1742 E2)")).toBeUndefined();
    expect(a("aws-infra #322: lease fence")).toBeUndefined();
    expect(a("no refs at all")).toBeUndefined();
  });
  it("references inside code spans are ignored", () => {
    expect(a("`foo#3` then (#4)")).toEqual({ repo: "harmoniqs/amicode", number: 4 });
  });
});

describe("parsePlanTable — refusals are named", () => {
  const kindOf = (raw: string) => {
    try {
      parsePlanTable(raw);
    } catch (e) {
      expect(e).toBeInstanceOf(PlanTableError);
      expect((e as Error).name).toBe("PlanTableError");
      return (e as PlanTableError).kind;
    }
    throw new Error("expected a PlanTableError");
  };

  it("no `## Plan` section", () => {
    expect(kindOf("---\nspec_id: x\n---\n\n# nothing\n")).toBe("missing-table");
  });
  it("wrong header columns", () => {
    expect(kindOf(mini("").replace("| task_type |", "| type |"))).toBe("bad-header");
  });
  it("a row with the wrong cell count", () => {
    expect(kindOf(mini("| 0 | 1 | step | amicode | implement-slice |\n"))).toBe("bad-row");
  });
  it("a non-integer row number", () => {
    expect(kindOf(mini("| x | 1 | step | amicode | implement-slice | — |\n"))).toBe("bad-row");
  });
  it("a duplicate row number", () => {
    expect(kindOf(mini("| 0 | 1 | a | amicode | bookkeeping | — |\n| 0 | 1 | b | amicode | bookkeeping | — |\n"))).toBe("duplicate-row");
  });
  it("`after` naming a row that does not exist", () => {
    expect(kindOf(mini("| 0 | 1 | a | amicode | bookkeeping | 7 |\n"))).toBe("dangling-after");
  });
  it("`after` cycle", () => {
    expect(kindOf(mini("| 0 | 1 | a | amicode | bookkeeping | 1 |\n| 1 | 1 | b | amicode | bookkeeping | 0 |\n"))).toBe("after-cycle");
  });
  it("an empty table", () => {
    expect(kindOf(mini(""))).toBe("missing-table");
  });
  it("task_type outside TASK_TYPES is refused", () => {
    expect(kindOf(mini("| 0 | 1 | a | amicode | experiment | — |\n"))).toBe("bad-task-type");
  });
});

describe("provenance", () => {
  it("round-trips spec id, row and hash", () => {
    const m = provenanceMarker("spec-a", 12, "f".repeat(64));
    expect(parseProvenance(`hello\n${m}\n`)).toEqual({ spec_id: "spec-a", row: 12, design_hash: "f".repeat(64) });
    expect(parseProvenance("no marker")).toBeUndefined();
  });
});

describe("fileSlices — idempotent against a faked gh layer", () => {
  const steps = parsePlanTable(realRaw);
  const fm = parseFrontmatter(realRaw);
  if (!fm.ok) throw new Error(fm.error);
  const specId = String(fm.data.spec_id);
  const hash = designHash(fm.data);
  const prd = { repo: "harmoniqs/amicode", number: 1820 };

  it("run 1 creates N-1 issues + adopts #1740 + E edges + N sub-issue links; run 2 creates 0 / 0 / 0", () => {
    const gh = new FakeGh();
    gh.seed("harmoniqs/amicode", 1820);
    gh.seed("harmoniqs/amicode", 1740, "live skills, filed by hand");
    const r1 = fileSlices(steps, { specId, designHash: hash, prd, gh });
    expect(r1.created_issues).toBe(49);
    expect(r1.adopted_issues).toBe(1);
    expect(r1.edited_bodies).toBe(1);
    expect(r1.created_edges).toBe(53);
    expect(r1.created_sub_issues).toBe(50);
    expect(gh.created).toEqual({ issues: 49, subIssues: 50, blockedBy: 53 });
    expect(gh.edits).toBe(1);

    // Edges resolve to the right issues: row 2's issue is blocked by row 38's.
    const issueOf = (row: number) => r1.rows.find((x) => x.row === row)!.issue!;
    const r2id = gh.issues.find((i) => i.repo === issueOf(2).repo && i.number === issueOf(2).number)!.id;
    const r38id = gh.issues.find((i) => i.repo === issueOf(38).repo && i.number === issueOf(38).number)!.id;
    expect(gh.blockedBy.get(r2id)).toEqual([r38id]);
    // Cross-repo rows land in their own repo.
    expect(issueOf(47).repo).toBe("harmoniqs/aws-infra");
    // Row 10 IS #1740; row 21 (after 10) is blocked by it.
    expect(issueOf(10)).toEqual({ repo: "harmoniqs/amicode", number: 1740 });
    expect(r1.rows.find((x) => x.row === 10)!.status).toBe("adopted");
    const id1740 = gh.issues.find((i) => i.number === 1740)!.id;
    const r21id = gh.issues.find((i) => i.repo === issueOf(21).repo && i.number === issueOf(21).number)!.id;
    expect(gh.blockedBy.get(r21id)).toEqual([id1740]);

    const r2 = fileSlices(steps, { specId, designHash: hash, prd, gh });
    expect(r2.created_issues).toBe(0);
    expect(r2.created_edges).toBe(0);
    expect(r2.created_sub_issues).toBe(0);
    expect(r2.adopted_issues).toBe(1);
    expect(r2.edited_bodies).toBe(0);
    expect(gh.created).toEqual({ issues: 49, subIssues: 50, blockedBy: 53 });
    expect(gh.edits).toBe(1);
  });

  it("the body carries spec id, row, tier and the provenance line with the design hash", () => {
    const gh = new FakeGh();
    fileSlices(steps.filter((s) => s.row === 0), { specId, designHash: hash, gh });
    const body = gh.issues[0].body!;
    expect(gh.issues[0].title).toBe("`amico spec slices` (A0a)");
    expect(body).toContain(specId);
    expect(body).toMatch(/\brow\b.*\b0\b/i);
    expect(body).toMatch(/tier.*1/i);
    expect(body).toContain("amico spec slices");
    expect(body).toContain(hash);
    expect(parseProvenance(body)).toEqual({ spec_id: specId, row: 0, design_hash: hash });
  });

  it("a second run after a partial first run only adds the missing pieces", () => {
    const gh = new FakeGh();
    gh.seed("harmoniqs/amicode", 1820);
    const sub = steps.filter((s) => [38, 3, 2].includes(s.row));
    // Simulate a crash: issues exist, no edges or links yet.
    for (const s of sub) gh.createIssue(`harmoniqs/${s.repo}`, s.title, `x\n${provenanceMarker(specId, s.row, hash)}\n`);
    gh.created = { issues: 0, subIssues: 0, blockedBy: 0 };
    const r = fileSlices(sub, { specId, designHash: hash, prd, gh });
    expect(r.created_issues).toBe(0);
    expect(r.created_edges).toBe(2); // 2←38, 38←3
    expect(r.created_sub_issues).toBe(3);
  });

  it("an issue for the same row under an older design hash is reused, not re-filed", () => {
    const gh = new FakeGh();
    const s0 = steps.filter((s) => s.row === 0);
    gh.createIssue("harmoniqs/amicode", "old", provenanceMarker(specId, 0, "0".repeat(64)));
    gh.created.issues = 0;
    const r = fileSlices(s0, { specId, designHash: hash, gh });
    expect(r.created_issues).toBe(0);
    expect(r.rows[0].status).toBe("existing");
  });

  it("without --prd, no sub-issue calls are made", () => {
    const gh = new FakeGh();
    gh.seed("harmoniqs/amicode", 1740);
    const r = fileSlices(steps, { specId, designHash: hash, gh });
    expect(r.created_issues).toBe(49);
    expect(r.created_sub_issues).toBe(0);
    expect(gh.calls.filter((c) => c.includes("SubIssue"))).toEqual([]);
  });
});

describe("fileSlices — adopting an existing issue (#1949 §5)", () => {
  const specId = "spec-mini";
  const hash = "a".repeat(64);
  const prd = { repo: "harmoniqs/amicode", number: 1820 };
  const steps = parsePlanTable(
    mini(
      "| 0 | 1 | base work | amicode | implement-slice | — |\n" +
        "| 1 | 1 | wire the thing (#77) | amicode | implement-slice | 0 |\n" +
        "| 2 | 2 | land arJev#5 fence | amicode | implement-slice | 1 |\n",
    ),
  );

  function world(arJevState: "open" | "closed" = "open") {
    const gh = new FakeGh();
    gh.seed("harmoniqs/amicode", 1820);
    gh.seed("harmoniqs/amicode", 77, "the hand-filed body\n\n- [ ] keep me");
    gh.seed("harmoniqs/arJev", 5, "cross-repo body", arJevState);
    return gh;
  }

  it("adoption creates no issue and edits the body once to append the marker; the original body is kept", () => {
    const gh = world();
    const r = fileSlices(steps, { specId, designHash: hash, prd, gh });
    expect(r.created_issues).toBe(1); // row 0 only
    expect(r.adopted_issues).toBe(2);
    expect(r.edited_bodies).toBe(2);
    expect(gh.created.issues).toBe(1);
    const i77 = gh.issues.find((i) => i.number === 77)!;
    expect(i77.body!.startsWith("the hand-filed body\n\n- [ ] keep me")).toBe(true);
    expect(parseProvenance(i77.body)).toEqual({ spec_id: specId, row: 1, design_hash: hash });
    expect(r.rows.map((x) => [x.row, x.status, x.issue])).toEqual([
      [0, "created", { repo: "harmoniqs/amicode", number: 101 }],
      [1, "adopted", { repo: "harmoniqs/amicode", number: 77 }],
      [2, "adopted", { repo: "harmoniqs/arJev", number: 5 }],
    ]);
  });

  it("a single adopting row: 0 issues created, exactly 1 body edit; second run 0 edits", () => {
    const gh = world();
    const one = steps.filter((s) => s.row === 1).map((s) => ({ ...s, needs: undefined }));
    const r1 = fileSlices(one, { specId, designHash: hash, prd, gh });
    expect([r1.created_issues, r1.edited_bodies, gh.created.issues, gh.edits]).toEqual([0, 1, 0, 1]);
    const r2 = fileSlices(one, { specId, designHash: hash, prd, gh });
    expect([r2.created_issues, r2.edited_bodies, gh.created.issues, gh.edits]).toEqual([0, 0, 0, 1]);
    expect(r2.rows[0].status).toBe("adopted");
  });

  it("adopted issues are linked under the PRD and carry the blocked-by edges; second run is idempotent", () => {
    const gh = world();
    fileSlices(steps, { specId, designHash: hash, prd, gh });
    const id = (repo: string, n: number) => gh.issues.find((i) => i.repo === repo && i.number === n)!.id;
    const prdKids = gh.subIssues.get(id("harmoniqs/amicode", 1820));
    expect(prdKids).toEqual(expect.arrayContaining([id("harmoniqs/amicode", 77), id("harmoniqs/arJev", 5)]));
    expect(gh.blockedBy.get(id("harmoniqs/amicode", 77))).toEqual([id("harmoniqs/amicode", 101)]);
    expect(gh.blockedBy.get(id("harmoniqs/arJev", 5))).toEqual([id("harmoniqs/amicode", 77)]);
    const r2 = fileSlices(steps, { specId, designHash: hash, prd, gh });
    expect(r2).toMatchObject({ created_issues: 0, created_edges: 0, created_sub_issues: 0, edited_bodies: 0, adopted_issues: 2 });
    expect(gh.edits).toBe(2);
  });

  it("a marker under an older design hash counts as present (no re-edit on a spec revision)", () => {
    const gh = world();
    gh.issues.find((i) => i.number === 77)!.body = `x\n${provenanceMarker(specId, 1, "0".repeat(64))}\n`;
    const one = steps.filter((s) => s.row === 1).map((s) => ({ ...s, needs: undefined }));
    expect(fileSlices(one, { specId, designHash: hash, gh }).edited_bodies).toBe(0);
  });

  it("another spec's marker on the adopted issue does not count; this spec's marker is appended beside it", () => {
    const gh = world();
    gh.issues.find((i) => i.number === 77)!.body = `x\n${provenanceMarker("spec-other", 4, hash)}\n`;
    const one = steps.filter((s) => s.row === 1).map((s) => ({ ...s, needs: undefined }));
    expect(fileSlices(one, { specId, designHash: hash, gh }).edited_bodies).toBe(1);
    const body = gh.issues.find((i) => i.number === 77)!.body!;
    expect(body).toContain("spec=spec-other row=4");
    expect(body).toContain(`spec=${specId} row=1`);
    expect(fileSlices(one, { specId, designHash: hash, gh }).edited_bodies).toBe(0);
  });

  it("an issue FILED for the row before it adopted is reported as superseded and left untouched", () => {
    const gh = world();
    const dup = gh.createIssue("harmoniqs/amicode", "wire the thing (#77)", `old\n${provenanceMarker(specId, 1, hash)}\n`);
    gh.created.issues = 0;
    const one = steps.filter((s) => s.row === 1).map((s) => ({ ...s, needs: undefined }));
    const r = fileSlices(one, { specId, designHash: hash, gh });
    expect(r.created_issues).toBe(0);
    expect(r.rows[0]).toMatchObject({ status: "adopted", issue: { number: 77 }, superseded: { repo: "harmoniqs/amicode", number: dup.number } });
    expect(gh.issues.find((i) => i.id === dup.id)!.body).toBe(`old\n${provenanceMarker(specId, 1, hash)}\n`);
  });

  it("a CLOSED adopted issue is still adopted, marked, linked and wired (a closed blocker is a satisfied edge)", () => {
    const gh = world("closed");
    const r = fileSlices(steps, { specId, designHash: hash, prd, gh });
    const row2 = r.rows.find((x) => x.row === 2)!;
    expect(row2).toMatchObject({ status: "adopted", state: "closed", issue: { repo: "harmoniqs/arJev", number: 5 } });
    const i5 = gh.issues.find((i) => i.number === 5)!;
    expect(parseProvenance(i5.body)?.row).toBe(2);
    expect(gh.subIssues.get(gh.issues.find((i) => i.number === 1820)!.id)).toContain(i5.id);
    expect(gh.blockedBy.get(i5.id)).toHaveLength(1);
  });

  it("dry-run shows `adopts` on the row and makes zero gh calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spec-slices-adopt-"));
    try {
      const p = join(dir, "spec.md");
      writeFileSync(p, mini("| 0 | 1 | wire the thing (#77) | amicode | implement-slice | — |\n"));
      const gh = trapGh();
      const r = await specVerb(["slices", p, "--dry-run"], { slicesGh: gh });
      expect(gh.calls).toBe(0);
      expect((r.json as { rows: Array<{ adopts?: string }> }).rows[0].adopts).toBe("harmoniqs/amicode#77");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ghApiSlices — the `gh api` argument shapes", () => {
  function recorder(responses: Record<string, string> = {}) {
    const calls: string[][] = [];
    const runner: GhApiRunner = (args) => {
      calls.push(args);
      const key = Object.keys(responses).find((k) => args.join(" ").includes(k));
      return { code: 0, stdout: key ? responses[key] : "[]", stderr: "" };
    };
    return { calls, runner };
  }

  it("sub-issue: POST …/issues/{parent}/sub_issues with the numeric sub_issue_id", () => {
    const { calls, runner } = recorder();
    ghApiSlices(runner).addSubIssue({ repo: "harmoniqs/amicode", number: 1820 }, 4242);
    expect(calls[0]).toEqual(["-X", "POST", "repos/harmoniqs/amicode/issues/1820/sub_issues", "-F", "sub_issue_id=4242"]);
  });

  it("blocked-by: POST …/issues/{n}/dependencies/blocked_by with the numeric issue_id", () => {
    const { calls, runner } = recorder();
    ghApiSlices(runner).addBlockedBy({ repo: "harmoniqs/arJev", number: 7 }, 99);
    expect(calls[0]).toEqual(["-X", "POST", "repos/harmoniqs/arJev/issues/7/dependencies/blocked_by", "-F", "issue_id=99"]);
  });

  it("create: POST …/issues with raw title/body fields, returns id + number", () => {
    const { calls, runner } = recorder({ "repos/harmoniqs/amicode/issues": '{"id": 555, "number": 12, "body": "b"}' });
    const i = ghApiSlices(runner).createIssue("harmoniqs/amicode", "@title", "body");
    expect(calls[0]).toEqual(["-X", "POST", "repos/harmoniqs/amicode/issues", "-f", "title=@title", "-f", "body=body"]);
    expect(i).toEqual({ id: 555, number: 12, repo: "harmoniqs/amicode", body: "b" });
  });

  it("findFiled: paginated issue search scoped to the repo and spec id, PRs dropped", () => {
    const { calls, runner } = recorder({
      "search/issues": JSON.stringify([
        { items: [{ id: 1, number: 3, body: "a" }, { id: 2, number: 4, body: "b", pull_request: {} }] },
        { items: [{ id: 5, number: 6, body: "c" }] },
      ]),
    });
    const got = ghApiSlices(runner).findFiled("harmoniqs/amicode", "spec-x");
    expect(got.map((g) => g.number)).toEqual([3, 6]);
    const args = calls[0];
    expect(args).toContain("--paginate");
    expect(args).toContain("--slurp");
    expect(args.join(" ")).toContain("repo:harmoniqs/amicode");
    expect(args.join(" ")).toContain('"spec-x"');
  });

  it("list endpoints are paginated and flattened", () => {
    const { runner } = recorder({
      "sub_issues": JSON.stringify([[{ id: 1, number: 2, body: "", repository: { full_name: "harmoniqs/arJev" } }], [{ id: 3, number: 4, body: "" }]]),
    });
    const got = ghApiSlices(runner).listSubIssues({ repo: "harmoniqs/amicode", number: 1 });
    expect(got).toEqual([
      { id: 1, number: 2, body: "", repo: "harmoniqs/arJev" },
      { id: 3, number: 4, body: "", repo: undefined },
    ]);
  });

  it("getIssue: GET …/issues/{n}, returns id, number, body and state", () => {
    const { calls, runner } = recorder({ "repos/harmoniqs/amicode/issues/1740": '{"id": 9, "number": 1740, "body": null, "state": "closed"}' });
    const i = ghApiSlices(runner).getIssue({ repo: "harmoniqs/amicode", number: 1740 });
    expect(calls[0]).toEqual(["repos/harmoniqs/amicode/issues/1740"]);
    expect(i).toEqual({ id: 9, number: 1740, repo: "harmoniqs/amicode", body: "", state: "closed" });
  });

  it("editIssueBody: PATCH …/issues/{n} with the raw body field", () => {
    const { calls, runner } = recorder({ "issues/7": "{}" });
    ghApiSlices(runner).editIssueBody({ repo: "harmoniqs/arJev", number: 7 }, "@b");
    expect(calls[0]).toEqual(["-X", "PATCH", "repos/harmoniqs/arJev/issues/7", "-f", "body=@b"]);
  });

  it("a failed gh call throws with gh's stderr", () => {
    const runner: GhApiRunner = () => ({ code: 1, stdout: "", stderr: "HTTP 403: nope" });
    expect(() => ghApiSlices(runner).addBlockedBy({ repo: "harmoniqs/a", number: 1 }, 2)).toThrow(/403/);
  });
});

describe("amico spec slices — the verb", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "spec-slices-"));
    path = join(dir, "spec.md");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const json = (r: { json: unknown }) => r.json as Record<string, unknown>;

  it("--dry-run prints the plan as JSON and makes zero gh calls", async () => {
    const gh = trapGh();
    const r = await specVerb(["slices", REAL_SPEC, "--prd", "harmoniqs/amicode#1820", "--dry-run"], { slicesGh: gh });
    expect(gh.calls).toBe(0);
    expect(r.code).toBe(0);
    const j = json(r);
    expect(j.dry_run).toBe(true);
    expect((j.rows as unknown[]).length).toBe(50);
    expect((j.edges as unknown[]).length).toBe(53);
    expect(j.repos).toEqual(expect.arrayContaining(["harmoniqs/amicode", "harmoniqs/amicissimo", "harmoniqs/arJev", "harmoniqs/aws-infra", "harmoniqs/Telaio.jl"]));
    expect(j.prd).toBe("harmoniqs/amicode#1820");
    expect(j.design_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("files through the injected layer; second run files nothing", async () => {
    const gh = new FakeGh();
    gh.seed("harmoniqs/amicode", 1820);
    gh.seed("harmoniqs/amicode", 1740);
    const r1 = await specVerb(["slices", REAL_SPEC, "--prd", "harmoniqs/amicode#1820"], { slicesGh: gh });
    expect(r1.code).toBe(0);
    expect(json(r1)).toMatchObject({ created_issues: 49, adopted_issues: 1, edited_bodies: 1, created_edges: 53, created_sub_issues: 50 });
    const r2 = await specVerb(["slices", REAL_SPEC, "--prd=harmoniqs/amicode#1820"], { slicesGh: gh });
    expect(json(r2)).toMatchObject({ created_issues: 0, edited_bodies: 0, created_edges: 0, created_sub_issues: 0 });
  });

  it("a malformed table is exit 65 with the named error, and no gh calls", async () => {
    writeFileSync(path, mini("| 0 | 1 | a | amicode | experiment | — |\n"));
    const gh = trapGh();
    const r = await specVerb(["slices", path], { slicesGh: gh });
    expect(r.code).toBe(65);
    expect(json(r)).toMatchObject({ ok: false, error_kind: "bad-task-type" });
    expect(gh.calls).toBe(0);
  });

  it("a spec without spec_id is refused (the provenance key needs it)", async () => {
    writeFileSync(path, mini("| 0 | 1 | a | amicode | bookkeeping | — |\n", "title: none"));
    const r = await specVerb(["slices", path, "--dry-run"], { slicesGh: trapGh() });
    expect(r.code).toBe(65);
  });

  it("usage errors are exit 64: bad --prd, unknown flag, missing path", async () => {
    expect((await specVerb(["slices", REAL_SPEC, "--prd", "amicode-1820", "--dry-run"], { slicesGh: trapGh() })).code).toBe(64);
    expect((await specVerb(["slices", REAL_SPEC, "--critics", "2"], { slicesGh: trapGh() })).code).toBe(64);
    expect((await specVerb(["slices"], { slicesGh: trapGh() })).code).toBe(64);
  });

  it("review does not accept the slices-only flags", async () => {
    expect((await specVerb(["review", REAL_SPEC, "--dry-run"])).code).toBe(64);
  });

  it("a gh failure mid-run is a non-zero exit with the partial report (re-run resumes)", async () => {
    const gh = new FakeGh();
    let n = 0;
    const orig = gh.createIssue.bind(gh);
    gh.createIssue = (repo, title, body) => {
      if (++n === 3) throw new Error("HTTP 502");
      return orig(repo, title, body);
    };
    const r = await specVerb(["slices", REAL_SPEC], { slicesGh: gh });
    expect(r.code).toBe(1);
    expect(json(r)).toMatchObject({ ok: false });
    expect(String(json(r).error)).toContain("502");
  });

  it("is CLI-only: the MCP facade refuses `amico_spec slices`", async () => {
    const out = (await callMcpTool("amico_spec", ["slices", REAL_SPEC, "--dry-run"])) as Record<string, unknown>;
    expect(out.ok).toBe(false);
    expect(String(out.error)).toMatch(/CLI-only/);
  });
});
