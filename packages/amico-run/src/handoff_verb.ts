// `amico handoff` — the atomic repo-handoff verb (spec-20260804-211500;
// memory: feedback_repo_handoff_access). Grant → verify → receipt, so "can they
// read it?" is a fact the CLI establishes BEFORE anything is announced. The
// 201-vs-204 distinction is the whole point: 204 = access now; 201 = GitHub
// emailed an invitation and the repo still 404s until accepted — the verb exits
// 1 so a "grant then announce" script stops before announcing.
//
//   amico handoff grant <org>/<repo> <handle> [--permission push] [--also h2,h3]
//   amico handoff check <org>/<repo> <handle>          — exit 0 iff readable now
//   amico handoff lookup <org>/<repo> <substr>         — find a handle in collaborators
//
// GitHub access rides `gh api` through an INJECTED runner (the exec seam — same
// precedent as the clock injection in note_verb): vitest fakes the seam, no
// network in tests. Pure receipt/exit logic lives in handoff.ts.

import { spawnSync } from "node:child_process";
import {
  checkReceipt,
  exitCodeFor,
  grantReceipt,
  handoffLine,
  httpStatus,
  isPermission,
  isRepoSlug,
  type HandleReceipt,
  type Permission,
} from "./handoff.js";
import type { VerbResult } from "./verbs.js";

export interface GhCall {
  code: number; // process exit of `gh`
  http: number | undefined; // parsed HTTP status (from -i output)
  stdout: string;
  stderr: string;
}

export type GhRunner = (args: string[]) => GhCall;

/** The real exec seam: `gh api <args>` with -i so HTTP status is recoverable. */
const defaultRunner: GhRunner = (args) => {
  const r = spawnSync("gh", ["api", "-i", ...args], { encoding: "utf8" });
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  return { code: r.status ?? 1, http: httpStatus(stdout + "\n" + stderr), stdout, stderr };
};

function fail(subcommand: string, error: string): VerbResult {
  return { json: { verb: "handoff", subcommand, error }, code: 64 };
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/** GET the collaborator record → true/false/undefined(API failed). */
function collaboratorState(runner: GhRunner, repo: string, handle: string): boolean | undefined {
  const r = runner([`repos/${repo}/collaborators/${handle}`]);
  if (r.http === 204 || r.code === 0) return true;
  if (r.http === 404) return false;
  return undefined; // API failure (403, 5xx, network) — caller treats as failure lane
}

/** GET pending invitations → is this handle invited? (false on API failure, with stderr relayed upstream by the caller's receipt). */
function invitedState(runner: GhRunner, repo: string, handle: string): { invited: boolean; error?: string } {
  const r = runner([`repos/${repo}/invitations`]);
  if (r.code !== 0) return { invited: false, error: r.stderr.trim() || "invitations lookup failed" };
  return { invited: r.stdout.includes(`"login": "${handle}"`) || r.stdout.includes(`"login":"${handle}"`) };
}

// ── grant ─────────────────────────────────────────────────────────────────────
function grant(argv: string[], runner: GhRunner): VerbResult {
  const [repo, handle] = argv.filter((a) => !a.startsWith("--"));
  if (!repo || !isRepoSlug(repo)) return fail("grant", "usage: amico handoff grant <org>/<repo> <handle> [--permission pull|push|maintain|admin] [--also h2,h3]");
  if (!handle) return fail("grant", "grant needs a recipient handle");
  const permRaw = flagValue(argv, "--permission") ?? "push";
  if (!isPermission(permRaw)) return fail("grant", `bad --permission "${permRaw}" (want one of pull|push|maintain|admin)`);
  const permission: Permission = permRaw;
  const note = flagValue(argv, "--note");
  const also = (flagValue(argv, "--also") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const handles = [handle, ...also];

  const receipts: HandleReceipt[] = handles.map((h) => {
    const put = runner(["-X", "PUT", `repos/${repo}/collaborators/${h}`, "-F", `permission=${permission}`]);
    const collaborator = collaboratorState(runner, repo, h);
    const invited = collaborator === false ? invitedState(runner, repo, h).invited : false;
    return grantReceipt(
      h,
      permission,
      put.http,
      { collaborator: collaborator === true, invited },
      put.code !== 0 ? put.stderr : undefined,
    );
  });

  const json: Record<string, unknown> = { verb: "handoff", subcommand: "grant", repo, receipts };
  const line = handoffLine(repo, receipts);
  if (line) json.handoff_line = line;
  if (note) json.note = note;
  if (receipts.some((r) => r.access === "pending-acceptance")) {
    json.warning = "one or more recipients have an UNACCEPTED invitation — the repo 404s for them until they accept; do not announce yet";
  }
  return { json, code: exitCodeFor(receipts) };
}

// ── check ─────────────────────────────────────────────────────────────────────
function check(argv: string[], runner: GhRunner): VerbResult {
  const [repo, handle] = argv.filter((a) => !a.startsWith("--"));
  if (!repo || !isRepoSlug(repo)) return fail("check", "usage: amico handoff check <org>/<repo> <handle>");
  if (!handle) return fail("check", "check needs a recipient handle");

  const collaborator = collaboratorState(runner, repo, handle);
  if (collaborator === undefined) {
    const receipt: HandleReceipt = { handle, access: "failed", detail: "collaborator lookup failed (auth? network? repo?)" };
    return { json: { verb: "handoff", subcommand: "check", repo, receipt }, code: 2 };
  }
  const inv = collaborator ? { invited: false } : invitedState(runner, repo, handle);
  const receipt = checkReceipt(handle, { collaborator, invited: inv.invited }, inv.error);
  return { json: { verb: "handoff", subcommand: "check", repo, receipt }, code: exitCodeFor([receipt]) };
}

// ── lookup ────────────────────────────────────────────────────────────────────
function lookup(argv: string[], runner: GhRunner): VerbResult {
  const [repo, query] = argv.filter((a) => !a.startsWith("--"));
  if (!repo || !isRepoSlug(repo)) return fail("lookup", "usage: amico handoff lookup <org>/<repo> <substr>");
  if (!query) return fail("lookup", "lookup needs a substring to match against collaborators' logins");

  const r = runner([`repos/${repo}/collaborators`, "--jq", ".[].login"]);
  if (r.code !== 0) {
    return { json: { verb: "handoff", subcommand: "lookup", repo, error: r.stderr.trim() || "collaborators lookup failed" }, code: 2 };
  }
  const q = query.toLowerCase();
  const matches = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0 && s.toLowerCase().includes(q));
  return { json: { verb: "handoff", subcommand: "lookup", repo, query, matches }, code: 0 };
}

// ── verb entry ────────────────────────────────────────────────────────────────
export function handoffVerb(argv: string[], runner: GhRunner = defaultRunner): VerbResult {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "grant":
      return grant(rest, runner);
    case "check":
      return check(rest, runner);
    case "lookup":
      return lookup(rest, runner);
    default:
      return {
        json: {
          verb: "handoff",
          error: `unknown subcommand "${sub ?? ""}" — want grant | check | lookup`,
          usage: [
            "amico handoff grant <org>/<repo> <handle> [--permission push] [--also h2,h3]",
            "amico handoff check <org>/<repo> <handle>",
            "amico handoff lookup <org>/<repo> <substr>",
          ],
        },
        code: 64,
      };
  }
}
