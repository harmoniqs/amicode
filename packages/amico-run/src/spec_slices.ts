// packages/amico-run/src/spec_slices.ts — `amico spec slices` (rd-system v2.1 A0a, #1900).
//
// The spec executes itself: a spec's `## Plan` table (`# | tier | step | repo | task_type |
// after`) is parsed into plan_compile's step shape (`CompiledStep`, `after` → `needs`) — there
// is no second plan format — and each row is filed as one issue in `harmoniqs/<repo>`, linked
// as a sub-issue of the PRD, with GitHub blocked-by edges from `after`.
//
// IDEMPOTENCY is keyed on the provenance marker every filed body carries:
//   <!-- amico-spec-slices spec=<spec_id> row=<n> hash=<design_hash> -->
// The key is (spec_id, row). The hash rides along as provenance but is NOT part of the key: a
// spec revision that changes the decision surface must not re-file every row as a duplicate.
// Existing issues are found from two sources, unioned: the repo's issue search (scoped to the
// spec id) and — when a PRD is given — the PRD's sub-issue list, which is strongly consistent
// where search is eventually consistent (a quick re-run would otherwise duplicate).
//
// ADOPTION (#1949 §5): a row whose step text's first issue reference is `(#N)`, a leading `#N`,
// `repo#N` or `owner/repo#N` adopts that existing issue instead of filing one — the marker is
// appended to its body (once), and it is linked and wired like a filed row. See parseAdoption.
//
// GITHUB rides `gh api` through an injected layer (`SlicesGh`) over an injected runner
// (`GhApiRunner`) — the handoff_verb exec-seam precedent. The real runner spawns `gh` from
// PATH, which in an agent session is the amico-gh shim (gh_shim.ts), so writes go out under
// the App identity when one is configured and as the user's gh otherwise. Tests fake the seam.
import { spawnSync } from "node:child_process";
import { TASK_TYPES } from "./ledger.js";
import type { CompiledStep } from "./plan_compile.js";

export const SLICES_ORG = "harmoniqs";
const VERB_TAG = "amico-spec-slices";

export type PlanTableErrorKind =
  | "missing-table"
  | "bad-header"
  | "bad-row"
  | "duplicate-row"
  | "bad-task-type"
  | "dangling-after"
  | "after-cycle";

/** A Plan table the verb refuses to file. `kind` is the machine-readable name. */
export class PlanTableError extends Error {
  override name = "PlanTableError";
  constructor(
    readonly kind: PlanTableErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/** One Plan row in `CompiledStep` shape. `id` is the row number as a string and `needs` are the
 *  `after` row ids. The Plan table has no model column — routing picks the model at dispatch —
 *  so `model` is the empty string, never a guessed id. */
export interface SliceStep extends CompiledStep {
  row: number;
  tier: number;
  title: string;
  repo: string;
  /** Set when the step text's first issue reference names an existing issue to ADOPT
   *  (`parseAdoption`): the row files no new issue, it marks and links that one. */
  adopts?: IssueAddr;
}

const EXPECTED_HEADER = ["#", "tier", "step", "repo", "task_type", "after"];
const NONE = new Set(["—", "–", "-", ""]);

// ── adoption (#1949 §5) ──────────────────────────────────────────────────────
// A row whose step text's FIRST issue reference is one of these ADOPTS that issue:
//   `(#N)`            — exactly a parenthesized number; the issue is in the row's repo
//   `#N` leading      — the step text BEGINS with it (the step names the issue); row's repo
//   `repo#N`          — harmoniqs/<repo>#N (no space before `#`)
//   `owner/repo#N`    — verbatim
// Any other first reference — a bare mid-text `#N`, `(#N more words)`, a spaced `repo #N` —
// is prose about context, and the row files a new issue as before. Only the FIRST reference is
// consulted, so a non-adopting first reference blocks a later adopting one. References inside
// `code spans` are ignored.
const ISSUE_REF_RE = /(?<![\w./#-])(?:([A-Za-z0-9_.-]+)\/)?([A-Za-z0-9_.-]+)?#(\d+)(?!\w)/g;

export function parseAdoption(stepText: string, rowRepo: string): IssueAddr | undefined {
  const text = stepText.trim();
  const scan = text.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
  ISSUE_REF_RE.lastIndex = 0;
  const m = ISSUE_REF_RE.exec(scan);
  if (!m) return undefined;
  const [whole, owner, repo, num] = m;
  const number = Number(num);
  if (owner && repo) return { repo: `${owner}/${repo}`, number };
  if (repo) return { repo: `${SLICES_ORG}/${repo}`, number };
  const end = m.index + whole.length;
  const parenthesized = scan[m.index - 1] === "(" && scan[end] === ")";
  if (parenthesized || m.index === 0) return { repo: `${SLICES_ORG}/${rowRepo}`, number };
  return undefined;
}

/** Split a markdown table line on UNESCAPED pipes, dropping the outer empties. */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && line[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "|") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  const t = line.trim();
  if (t.startsWith("|")) out.shift();
  if (t.endsWith("|") && !t.endsWith("\\|")) out.pop();
  return out.map((s) => s.trim());
}

/** Parse the `## Plan` section's table. Throws `PlanTableError` on anything it would have to
 *  guess about — a filed issue is a public write, so ambiguity is a refusal, not a best effort. */
export function parsePlanTable(markdown: string): SliceStep[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Plan\s*$/.test(l));
  if (start < 0) throw new PlanTableError("missing-table", "no `## Plan` section in the spec");
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++)
    if (/^#{1,2}\s/.test(lines[i])) {
      end = i;
      break;
    }
  const section = lines.slice(start + 1, end);
  const headerAt = section.findIndex((l) => l.trim().startsWith("|"));
  if (headerAt < 0) throw new PlanTableError("missing-table", "the `## Plan` section has no table");

  const header = cells(section[headerAt]);
  if (header.length !== EXPECTED_HEADER.length || header.some((h, i) => h !== EXPECTED_HEADER[i]))
    throw new PlanTableError("bad-header", `Plan table header must be | ${EXPECTED_HEADER.join(" | ")} |, got | ${header.join(" | ")} |`);
  const sep = section[headerAt + 1];
  if (sep === undefined || !cells(sep).every((c) => /^:?-+:?$/.test(c)))
    throw new PlanTableError("bad-header", "Plan table header is not followed by a |---| separator line");

  const steps: SliceStep[] = [];
  const seen = new Set<number>();
  for (let i = headerAt + 2; i < section.length && section[i].trim().startsWith("|"); i++) {
    const line = section[i];
    const c = cells(line);
    const where = `Plan table line ${start + 2 + i}`;
    if (c.length !== EXPECTED_HEADER.length) throw new PlanTableError("bad-row", `${where}: expected ${EXPECTED_HEADER.length} cells, got ${c.length}`);
    const [num, tierRaw, title, repo, task_type, afterRaw] = c;
    if (!/^\d+$/.test(num)) throw new PlanTableError("bad-row", `${where}: row number must be a non-negative integer, got "${num}"`);
    const row = Number(num);
    if (seen.has(row)) throw new PlanTableError("duplicate-row", `${where}: row ${row} appears twice`);
    seen.add(row);
    if (!/^\d+$/.test(tierRaw)) throw new PlanTableError("bad-row", `${where}: tier must be an integer, got "${tierRaw}"`);
    if (title === "") throw new PlanTableError("bad-row", `${where}: empty step`);
    if (!/^[A-Za-z0-9._-]+$/.test(repo)) throw new PlanTableError("bad-row", `${where}: repo must be a bare harmoniqs repo name, got "${repo}"`);
    if (!(TASK_TYPES as readonly string[]).includes(task_type))
      throw new PlanTableError("bad-task-type", `${where}: task_type "${task_type}" is not one of (${TASK_TYPES.join(", ")})`);
    let needs: string[] = [];
    if (!NONE.has(afterRaw)) {
      needs = afterRaw.split(",").map((s) => s.trim());
      for (const n of needs)
        if (!/^\d+$/.test(n)) throw new PlanTableError("bad-row", `${where}: after must be row numbers or —, got "${afterRaw}"`);
    }
    const adopts = parseAdoption(title, repo);
    steps.push({
      id: String(row),
      model: "",
      task_type,
      ...(needs.length ? { needs } : {}),
      row,
      tier: Number(tierRaw),
      title,
      repo,
      ...(adopts ? { adopts } : {}),
    });
  }
  if (steps.length === 0) throw new PlanTableError("missing-table", "the Plan table has no rows");

  for (const s of steps)
    for (const n of s.needs ?? []) {
      if (!seen.has(Number(n))) throw new PlanTableError("dangling-after", `row ${s.row}: after names row ${n}, which is not in the table`);
      if (Number(n) === s.row) throw new PlanTableError("after-cycle", `row ${s.row} is after itself`);
    }
  const cycle = findCycle(steps);
  if (cycle) throw new PlanTableError("after-cycle", `after edges form a cycle: ${cycle.join(" → ")}`);
  return steps;
}

function findCycle(steps: SliceStep[]): string[] | undefined {
  const needs = new Map(steps.map((s) => [s.id, s.needs ?? []]));
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 2) return undefined;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1);
    stack.push(id);
    for (const n of needs.get(id) ?? []) {
      const c = visit(n);
      if (c) return c;
    }
    stack.pop();
    state.set(id, 2);
    return undefined;
  };
  for (const s of steps) {
    const c = visit(s.id);
    if (c) return c;
  }
  return undefined;
}

// ── provenance ───────────────────────────────────────────────────────────────

export function provenanceMarker(specId: string, row: number, designHash: string): string {
  return `<!-- ${VERB_TAG} spec=${specId} row=${row} hash=${designHash} -->`;
}

const MARKER_RE = new RegExp(`<!--\\s*${VERB_TAG}\\s+spec=(\\S+)\\s+row=(\\d+)\\s+hash=([0-9a-f]+)\\s*-->`);

export function parseProvenance(body: string | undefined): { spec_id: string; row: number; design_hash: string } | undefined {
  const m = MARKER_RE.exec(body ?? "");
  return m ? { spec_id: m[1], row: Number(m[2]), design_hash: m[3] } : undefined;
}

/** Does `body` carry THIS spec's marker for THIS row (any design hash)? An adopted issue may
 *  carry other specs' markers too, so every marker is checked, not just the first. */
export function hasProvenance(body: string | undefined, specId: string, row: number): boolean {
  const all = new RegExp(MARKER_RE.source, "g");
  for (const m of (body ?? "").matchAll(all)) if (m[1] === specId && Number(m[2]) === row) return true;
  return false;
}

/** The adopted issue's body with the provenance line + marker appended; the original is kept verbatim. */
export function adoptedBody(body: string, step: SliceStep, specId: string, designHash: string): string {
  return [
    body.replace(/\s+$/, ""),
    "",
    `Provenance: adopted by \`amico spec slices\` as \`${specId}\` row ${step.row} (tier ${step.tier}), design hash \`${designHash}\`.`,
    provenanceMarker(specId, step.row, designHash),
    "",
  ].join("\n");
}

export function issueBody(step: SliceStep, specId: string, designHash: string, prd?: IssueAddr): string {
  const after = step.needs?.length ? step.needs.map((n) => `row ${n}`).join(", ") : "none";
  return [
    `**Spec:** \`${specId}\` — Plan row ${step.row}, tier ${step.tier}, task_type \`${step.task_type}\`.`,
    "",
    `**After:** ${after} (set as GitHub blocked-by edges).`,
    ...(prd ? ["", `Part of ${prd.repo}#${prd.number}.`] : []),
    "",
    `Provenance: filed by \`amico spec slices\` from \`${specId}\` row ${step.row}, design hash \`${designHash}\`.`,
    provenanceMarker(specId, step.row, designHash),
    "",
  ].join("\n");
}

// ── the gh layer ─────────────────────────────────────────────────────────────

/** `repo` is always `owner/name`. */
export interface IssueAddr {
  repo: string;
  number: number;
}
export interface GhIssue extends IssueAddr {
  id: number; // the numeric REST id — what sub_issue_id / issue_id take, NOT the number
  body?: string;
  state?: "open" | "closed";
}

export interface SlicesGh {
  /** Issues in `repo` whose body may carry this spec's marker (the caller re-checks the marker). */
  findFiled(repo: string, specId: string): GhIssue[];
  createIssue(repo: string, title: string, body: string): GhIssue;
  /** One issue by address (adoption reads the body and state before it writes). */
  getIssue(addr: IssueAddr): GhIssue;
  /** Replace an issue's body (adoption appends the provenance marker, nothing else). */
  editIssueBody(addr: IssueAddr, body: string): void;
  listSubIssues(parent: IssueAddr): GhIssue[];
  addSubIssue(parent: IssueAddr, childId: number): void;
  listBlockedBy(issue: IssueAddr): GhIssue[];
  addBlockedBy(issue: IssueAddr, blockerId: number): void;
}

export type GhApiRunner = (args: string[]) => { code: number; stdout: string; stderr: string };

/** The real exec seam: `gh api <args>`, `gh` resolved from PATH (the amico-gh shim in sessions). */
export const defaultGhApiRunner: GhApiRunner = (args) => {
  const r = spawnSync("gh", ["api", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error.message) : "") };
};

type RawIssue = { id: number; number: number; body?: string | null; pull_request?: unknown; repository?: { full_name?: string } };

export function ghApiSlices(runner: GhApiRunner = defaultGhApiRunner): SlicesGh {
  const call = (args: string[]): unknown => {
    const r = runner(args);
    if (r.code !== 0) throw new Error(`gh api ${args.filter((a) => !a.startsWith("body=")).join(" ")} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    const out = r.stdout.trim();
    return out === "" ? undefined : JSON.parse(out);
  };
  /** `--paginate --slurp` yields an array of pages; a page is an array (list endpoints) or an
   *  object with `items` (search). Flatten either. */
  const flatten = (pages: unknown): RawIssue[] => {
    const arr = Array.isArray(pages) ? pages : [pages];
    return arr.flatMap((p) => (Array.isArray(p) ? p : p && typeof p === "object" && Array.isArray((p as { items?: unknown }).items) ? (p as { items: RawIssue[] }).items : [])) as RawIssue[];
  };
  const toIssue = (r: RawIssue, repo: string | undefined): GhIssue =>
    ({ id: r.id, number: r.number, body: r.body ?? "", repo: r.repository?.full_name ?? repo }) as GhIssue;
  const list = (path: string): GhIssue[] => flatten(call(["--paginate", "--slurp", `${path}?per_page=100`])).map((r) => toIssue(r, undefined));

  return {
    findFiled(repo, specId) {
      const q = `repo:${repo} is:issue in:body "${specId}"`;
      return flatten(call(["--paginate", "--slurp", "-X", "GET", "search/issues", "-f", `q=${q}`, "-f", "per_page=100"]))
        .filter((r) => r.pull_request === undefined)
        .map((r) => toIssue(r, repo));
    },
    createIssue(repo, title, body) {
      const r = call(["-X", "POST", `repos/${repo}/issues`, "-f", `title=${title}`, "-f", `body=${body}`]) as RawIssue;
      return { id: r.id, number: r.number, repo, body: r.body ?? body };
    },
    getIssue(a) {
      const r = call([`repos/${a.repo}/issues/${a.number}`]) as RawIssue & { state?: string };
      return { id: r.id, number: r.number, repo: a.repo, body: r.body ?? "", state: r.state === "closed" ? "closed" : "open" };
    },
    editIssueBody(a, body) {
      call(["-X", "PATCH", `repos/${a.repo}/issues/${a.number}`, "-f", `body=${body}`]);
    },
    listSubIssues: (p) => list(`repos/${p.repo}/issues/${p.number}/sub_issues`),
    addSubIssue(p, childId) {
      call(["-X", "POST", `repos/${p.repo}/issues/${p.number}/sub_issues`, "-F", `sub_issue_id=${childId}`]);
    },
    listBlockedBy: (i) => list(`repos/${i.repo}/issues/${i.number}/dependencies/blocked_by`),
    addBlockedBy(i, blockerId) {
      call(["-X", "POST", `repos/${i.repo}/issues/${i.number}/dependencies/blocked_by`, "-F", `issue_id=${blockerId}`]);
    },
  };
}

// ── filing ───────────────────────────────────────────────────────────────────

export interface SlicesPlanRow {
  row: number;
  tier: number;
  repo: string; // owner/name
  title: string;
  task_type: string;
  after: number[];
  /** `owner/repo#n` when the row adopts an existing issue instead of filing one. */
  adopts?: string;
}
export interface SlicesEdge {
  row: number; // blocked
  blocked_by: number; // blocker
}

export function planView(steps: SliceStep[]): { rows: SlicesPlanRow[]; edges: SlicesEdge[]; repos: string[] } {
  const rows = steps.map((s) => ({
    row: s.row,
    tier: s.tier,
    repo: `${SLICES_ORG}/${s.repo}`,
    title: s.title,
    task_type: s.task_type,
    after: (s.needs ?? []).map(Number),
    ...(s.adopts ? { adopts: `${s.adopts.repo}#${s.adopts.number}` } : {}),
  }));
  const edges = rows.flatMap((r) => r.after.map((b) => ({ row: r.row, blocked_by: b })));
  return { rows, edges, repos: [...new Set(rows.map((r) => r.repo))] };
}

export interface SlicesRowReport extends SlicesPlanRow {
  status: "created" | "existing" | "adopted";
  issue?: IssueAddr;
  /** The adopted issue's state — a closed issue is still adopted (see fileSlices). */
  state?: "open" | "closed";
  /** An issue previously FILED for this row (before it adopted) — reported, never touched. */
  superseded?: IssueAddr;
}
export interface SlicesReport {
  rows: SlicesRowReport[];
  edges: Array<SlicesEdge & { status: "created" | "existing" }>;
  created_issues: number;
  created_edges: number;
  created_sub_issues: number;
  adopted_issues: number;
  edited_bodies: number;
}

export function emptySlicesReport(): SlicesReport {
  return { rows: [], edges: [], created_issues: 0, created_edges: 0, created_sub_issues: 0, adopted_issues: 0, edited_bodies: 0 };
}

export interface FileSlicesOptions {
  specId: string;
  designHash: string;
  prd?: IssueAddr;
  gh: SlicesGh;
  /** Receives the report as it grows, so a mid-run failure still shows what was done. */
  progress?: SlicesReport;
}

/** File (or find) every row's issue, then link sub-issues, then set blocked-by edges. Each phase
 *  reads before it writes, so a re-run after any partial failure only adds what is missing. */
export function fileSlices(steps: SliceStep[], opts: FileSlicesOptions): SlicesReport {
  const { gh, specId, designHash, prd } = opts;
  const view = planView(steps);
  const ids = new Set(steps.map((s) => s.id));
  for (const s of steps)
    for (const n of s.needs ?? []) if (!ids.has(n)) throw new PlanTableError("dangling-after", `row ${s.row}: after names row ${n}, which is not being filed`);

  const report: SlicesReport = opts.progress ?? emptySlicesReport();

  // Existing issues, by row: the PRD's sub-issues (consistent) ∪ each repo's search (eventual).
  // Keyed on (row, repo): if a row's repo changes between revisions, the old issue is left alone
  // and the row is filed once where it now lives — and found there on every later run.
  const existing = new Map<string, GhIssue>();
  const consider = (i: GhIssue) => {
    const p = parseProvenance(i.body);
    const key = `${p?.row}@${i.repo}`;
    if (p && p.spec_id === specId && !existing.has(key)) existing.set(key, i);
  };
  const prdChildren = prd ? gh.listSubIssues(prd) : [];
  prdChildren.forEach(consider);
  for (const repo of view.repos) gh.findFiled(repo, specId).forEach(consider);

  // ADOPTION (#1949 §5): a row whose step text names an existing issue (`parseAdoption`) files
  // nothing — the named issue IS the slice. Its body gains the provenance marker unless this
  // spec+row marker is already there (any hash — idempotent), and it is linked and wired like a
  // filed one. A CLOSED adopted issue is still adopted, marked, linked and wired: the plan's DAG
  // stays whole, and a closed blocker is a satisfied edge. An issue FILED for the row before it
  // adopted is reported as `superseded` and left alone (closing a public issue is a human call).
  const byRow = new Map<number, GhIssue>();
  for (const [k, s] of steps.entries()) {
    const r = view.rows[k];
    const prior = existing.get(`${s.row}@${r.repo}`);
    if (s.adopts) {
      const issue = gh.getIssue(s.adopts);
      if (!hasProvenance(issue.body, specId, s.row)) {
        const body = adoptedBody(issue.body ?? "", s, specId, designHash);
        gh.editIssueBody(s.adopts, body);
        issue.body = body;
        report.edited_bodies++;
      }
      report.adopted_issues++;
      byRow.set(s.row, issue);
      const superseded = prior && prior.id !== issue.id ? { superseded: { repo: prior.repo, number: prior.number } } : {};
      report.rows.push({ ...r, status: "adopted", issue: { repo: issue.repo, number: issue.number }, state: issue.state ?? "open", ...superseded });
      continue;
    }
    let issue = prior;
    let status: "created" | "existing" = "existing";
    if (!issue) {
      issue = gh.createIssue(r.repo, s.title, issueBody(s, specId, designHash, prd));
      status = "created";
      report.created_issues++;
    }
    byRow.set(s.row, issue);
    report.rows.push({ ...r, status, issue: { repo: issue.repo, number: issue.number } });
  }

  if (prd) {
    const linked = new Set(prdChildren.map((c) => c.id));
    for (const s of steps) {
      const child = byRow.get(s.row)!;
      if (linked.has(child.id)) continue;
      gh.addSubIssue(prd, child.id);
      linked.add(child.id);
      report.created_sub_issues++;
    }
  }

  for (const s of steps) {
    if (!s.needs?.length) continue;
    const issue = byRow.get(s.row)!;
    const have = new Set(gh.listBlockedBy(issue).map((b) => b.id));
    for (const n of s.needs) {
      const blocker = byRow.get(Number(n))!;
      const edge = { row: s.row, blocked_by: Number(n) };
      if (have.has(blocker.id)) {
        report.edges.push({ ...edge, status: "existing" });
        continue;
      }
      gh.addBlockedBy(issue, blocker.id);
      have.add(blocker.id);
      report.edges.push({ ...edge, status: "created" });
      report.created_edges++;
    }
  }
  return report;
}
