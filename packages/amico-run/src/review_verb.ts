// packages/amico-run/src/review_verb.ts — `amico review post-check` (#1928,
// A15 + A10): the reviewer-App check-run, posted by the DISPATCHER only.
//
//   amico review post-check --repo <owner/repo> --sha <40-hex> \
//       --name reviewer-pass|charter-class --verdict <file.json>
//
// The verdict file is the panel's structured result:
//   {"verdict": "pass"|"block"|"neutral", "receipt_id": "<panel receipt>", "summary"?: "…"}
// and its vocabulary is code-enforced: pass → success, block → failure,
// neutral → neutral; anything else is refused before a credential is touched.
// The check-run summary carries the panel receipt id (also the external_id).
//
// Refusals, BEFORE any credential read: AMICO_GH_IDENTITY=agent (or any
// non-person value), and any engine-session marker in the env (OPENCODE,
// OPENCODE_PID, OPENCODE_SERVER_PASSWORD, AMICO_SESSION_ID) — sessions never
// post; the dispatcher runs this from its own process.
//
// HONEST LIMIT (stated in --help): agents run as the same OS user as the
// dispatcher, so the reviewer PEM is readable on disk by a deliberate session
// and the env markers can be unset. These refusals stop accidental and
// casual posting; they are not a security boundary. A reviewer-pass posted
// outside the dispatcher is a finding. Separate OS users (#1879/#1887) are the
// full fix.
//
// SECURITY: the reviewer token rides only the Authorization header; no output,
// error, or record carries it (GitHub's error body is never echoed).
import { existsSync, readFileSync } from "node:fs";
import { MINT_TIMEOUT_MS, type FetchImpl } from "./github_app.js";
import { engineSessionMarker, ensureReviewerToken, type IdentityDeps } from "./gh_identity.js";
import { ConfigError } from "./types.js";
import type { VerbResult } from "./verbs.js";

/** The code-enforced verdict vocabulary → check-run conclusion. */
export const REVIEW_VERDICT_CONCLUSION = { pass: "success", block: "failure", neutral: "neutral" } as const;
export type ReviewPanelVerdict = keyof typeof REVIEW_VERDICT_CONCLUSION;

export const REVIEW_CHECK_NAMES = ["reviewer-pass", "charter-class"] as const;

const HELP = [
  "amico review post-check --repo <owner/repo> --sha <40-hex> --name reviewer-pass|charter-class --verdict <file.json>",
  "",
  "Posts a completed check-run from the amico-reviewer GitHub App (credential: ~/.amico/github-apps/reviewer.json).",
  'Verdict file: {"verdict": "pass"|"block"|"neutral", "receipt_id": "<panel receipt id>", "summary"?: "..."}',
  "  pass → success, block → failure, neutral → neutral; the summary carries the panel receipt id.",
  "",
  "DISPATCHER-ONLY: refuses under AMICO_GH_IDENTITY=agent and when invoked from inside an engine session",
  "(OPENCODE / OPENCODE_PID / OPENCODE_SERVER_PASSWORD / AMICO_SESSION_ID in the env). Sessions never post.",
  "",
  "Honest limit: sessions run as the same OS user as the dispatcher, so the reviewer PEM is readable on disk and",
  "these env markers can be unset by a deliberate session. The refusal stops accidental posting; it is not a",
  "security boundary — a check-run posted outside the dispatcher is a finding. Separate OS users are the full fix.",
].join("\n");

export interface ReviewVerbCtx extends IdentityDeps {
  env?: NodeJS.ProcessEnv;
}

const usage = (error: string): VerbResult => ({ json: { ok: false, error, usage: HELP.split("\n")[0] }, code: 64 });

function parseFlags(argv: string[]): Record<string, string> | string {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = a.match(/^--(repo|sha|name|verdict)$/);
    if (!m) return `unexpected argument ${JSON.stringify(a)}`;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) return `--${m[1]} needs a value`;
    out[m[1]] = v;
    i++;
  }
  return out;
}

interface PanelVerdict {
  verdict: ReviewPanelVerdict;
  receipt_id: string;
  summary?: string;
}

function readVerdict(file: string): PanelVerdict | string {
  if (!existsSync(file)) return `verdict file not found: ${file}`;
  let d: unknown;
  try {
    d = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return `malformed verdict file ${file} (not JSON)`;
  }
  if (typeof d !== "object" || d === null || Array.isArray(d)) return `malformed verdict file ${file} (not a JSON object)`;
  const o = d as Record<string, unknown>;
  if (typeof o.verdict !== "string" || !Object.hasOwn(REVIEW_VERDICT_CONCLUSION, o.verdict))
    return `verdict must be one of ${Object.keys(REVIEW_VERDICT_CONCLUSION).join("|")} (got ${JSON.stringify(o.verdict ?? null)})`;
  if (typeof o.receipt_id !== "string" || o.receipt_id.trim() === "") return "verdict file needs a non-empty string receipt_id (the panel receipt)";
  if (o.summary !== undefined && typeof o.summary !== "string") return "verdict summary must be a string when present";
  return { verdict: o.verdict as ReviewPanelVerdict, receipt_id: o.receipt_id, ...(typeof o.summary === "string" ? { summary: o.summary } : {}) };
}

export async function reviewVerb(argv: string[], ctx: ReviewVerbCtx = {}): Promise<VerbResult> {
  const env = ctx.env ?? process.env;
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === "--help" || sub === "-h" || (sub === "post-check" && (rest.includes("--help") || rest.includes("-h"))))
    return { json: { usage: HELP }, code: sub === undefined ? 64 : 0 };
  if (sub !== "post-check") return usage(`unknown review subcommand ${JSON.stringify(sub)}`);

  // ── refusals: before any argument, file, or credential is read ──
  const identity = env.AMICO_GH_IDENTITY;
  if (identity !== undefined && identity !== "" && identity !== "person")
    return {
      json: { ok: false, error: `refused: review post-check never runs under AMICO_GH_IDENTITY=${identity} — the reviewer App is the dispatcher's alone` },
      code: 64,
    };
  const marker = engineSessionMarker(env);
  if (marker)
    return {
      json: { ok: false, error: `refused: invoked from inside an engine session (${marker} is set) — the dispatcher posts check-runs, sessions never do` },
      code: 64,
    };

  const flags = parseFlags(rest);
  if (typeof flags === "string") return usage(flags);
  const { repo, sha, name, verdict: verdictFile } = flags;
  if (!repo || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) return usage("--repo must be owner/repo");
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return usage("--sha must be a full 40-hex commit sha");
  if (!name || !(REVIEW_CHECK_NAMES as readonly string[]).includes(name)) return usage(`--name must be one of ${REVIEW_CHECK_NAMES.join("|")}`);
  if (!verdictFile) return usage("--verdict <file.json> is required");
  const v = readVerdict(verdictFile);
  if (typeof v === "string") return usage(v);
  const conclusion = REVIEW_VERDICT_CONCLUSION[v.verdict];

  let token: string;
  let slug: string | null;
  try {
    const t = await ensureReviewerToken({ ...ctx, env });
    token = t.token;
    slug = t.config.slug ?? null;
  } catch (e) {
    if (e instanceof ConfigError) return { json: { ok: false, error: e.message }, code: 64 };
    throw e;
  }

  const summary = [`Panel receipt: \`${v.receipt_id}\``, `Verdict: ${v.verdict} → ${conclusion}`, ...(v.summary ? ["", v.summary] : [])].join("\n").slice(0, 60_000);
  const body = {
    name,
    head_sha: sha,
    status: "completed",
    conclusion,
    external_id: v.receipt_id,
    completed_at: new Date((ctx.nowMs ?? Date.now)()).toISOString(),
    output: { title: `${name}: ${v.verdict}`, summary },
  };
  const fetchImpl = ctx.fetchImpl ?? (fetch as unknown as FetchImpl);
  let res: { status: number; json(): Promise<unknown> };
  try {
    res = await fetchImpl(`https://api.github.com/repos/${repo}/check-runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`, // secret: header carriage ONLY
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    });
  } catch {
    return { json: { ok: false, error: `check-run post to ${repo} did not answer within ${MINT_TIMEOUT_MS / 1000}s` }, code: 1 };
  }
  if (res.status !== 201)
    // GitHub's error body is never echoed — it is untrusted and could reflect a credential.
    return { json: { ok: false, error: `check-run post to ${repo} failed (HTTP ${res.status}) — check the reviewer App's checks:write permission and installation`, repo, sha, name }, code: 1 };
  let out: Record<string, unknown> = {};
  try {
    out = (await res.json()) as Record<string, unknown>;
  } catch {
    /* posted; id unknown */
  }
  return {
    json: {
      ok: true,
      check_run_id: typeof out.id === "number" ? out.id : null,
      html_url: typeof out.html_url === "string" ? out.html_url : null,
      conclusion,
      name,
      repo,
      sha,
      receipt_id: v.receipt_id,
      app: slug,
    },
    code: 0,
  };
}
