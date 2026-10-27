// `amico review post-check` (#1928, A15 + A10): reviewer-App check-run
// posting, dispatcher-only. Hermetic: fake fetch, throwaway keys, sandboxed
// apps dir. The refusal lanes must refuse BEFORE any credential is touched.
import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { reviewVerb, REVIEW_VERDICT_CONCLUSION } from "../src/review_verb.js";
import { fakeGithub, sandbox } from "./gh_identity_helpers.js";

const REVIEWER_TOKEN = "ghs_test_REVIEWER_minted_987654";
const AGENT_TOKEN = "ghs_test_AGENT_minted_abcdef123456";
const SHA = "0123456789abcdef0123456789abcdef01234567";

/** A dispatcher env: the sandbox minus every engine-session marker. */
function dispatcherEnv(sb: ReturnType<typeof sandbox>): Record<string, string> {
  const e: Record<string, string> = { ...sb.env };
  return e;
}

function verdictFile(sb: ReturnType<typeof sandbox>, v: unknown): string {
  const f = join(sb.root, `verdict-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, typeof v === "string" ? v : JSON.stringify(v));
  return f;
}

const args = (vf: string, name = "reviewer-pass", sha = SHA) => ["post-check", "--repo", "o/r", "--sha", sha, "--name", name, "--verdict", vf];

describe("review post-check: refusals (sessions never post)", () => {
  it("refuses under AMICO_GH_IDENTITY=agent — no mint, no post", async () => {
    const sb = sandbox();
    const fake = fakeGithub({ "2002": REVIEWER_TOKEN, "2001": AGENT_TOKEN });
    const vf = verdictFile(sb, { verdict: "neutral", receipt_id: "panel-1" });
    const r = await reviewVerb(args(vf), { env: { ...dispatcherEnv(sb), AMICO_GH_IDENTITY: "agent" }, fetchImpl: fake.impl });
    expect(r.code).toBe(64);
    expect(JSON.stringify(r.json)).toMatch(/AMICO_GH_IDENTITY=agent/);
    expect(fake.calls).toHaveLength(0);
  });
  it.each([
    ["OPENCODE", "1"],
    ["OPENCODE_PID", "4321"],
    ["AMICO_SESSION_ID", "ses_x"],
    ["OPENCODE_SERVER_PASSWORD", "pw"],
  ])("refuses inside an engine session (%s set) — no mint, no post", async (k, v) => {
    const sb = sandbox();
    const fake = fakeGithub({ "2002": REVIEWER_TOKEN });
    const vf = verdictFile(sb, { verdict: "pass", receipt_id: "panel-1" });
    const r = await reviewVerb(args(vf), { env: { ...dispatcherEnv(sb), [k]: v }, fetchImpl: fake.impl });
    expect(r.code).toBe(64);
    expect(JSON.stringify(r.json)).toMatch(/engine session/);
    expect(fake.calls).toHaveLength(0);
  });
  it("help text states the honest limit (same OS user)", async () => {
    const r = await reviewVerb(["post-check", "--help"], { env: {} });
    expect(r.code).toBe(0);
    expect(JSON.stringify(r.json)).toMatch(/same OS user/);
    expect(JSON.stringify(r.json)).toMatch(/dispatcher/);
  });
});

describe("review post-check: the code-enforced vocabulary", () => {
  it("the vocabulary is exactly pass/block/neutral → success/failure/neutral", () => {
    expect(REVIEW_VERDICT_CONCLUSION).toEqual({ pass: "success", block: "failure", neutral: "neutral" });
  });
  it.each([
    [{ verdict: "approve", receipt_id: "p" }, /verdict/],
    [{ verdict: "pass" }, /receipt_id/],
    [{ verdict: "pass", receipt_id: "" }, /receipt_id/],
    ["{nope", /malformed/],
  ])("rejects verdict %j before any credential is touched", async (v, msg) => {
    const sb = sandbox();
    const fake = fakeGithub({ "2002": REVIEWER_TOKEN });
    const r = await reviewVerb(args(verdictFile(sb, v)), { env: dispatcherEnv(sb), fetchImpl: fake.impl });
    expect(r.code).toBe(64);
    expect(JSON.stringify(r.json)).toMatch(msg);
    expect(fake.calls).toHaveLength(0);
  });
  it("rejects names outside reviewer-pass|charter-class, malformed sha/repo", async () => {
    const sb = sandbox();
    const fake = fakeGithub({ "2002": REVIEWER_TOKEN });
    const vf = verdictFile(sb, { verdict: "pass", receipt_id: "p" });
    expect((await reviewVerb(args(vf, "ci"), { env: dispatcherEnv(sb), fetchImpl: fake.impl })).code).toBe(64);
    expect((await reviewVerb(args(vf, "reviewer-pass", "abc"), { env: dispatcherEnv(sb), fetchImpl: fake.impl })).code).toBe(64);
    expect(
      (await reviewVerb(["post-check", "--repo", "not-a-repo", "--sha", SHA, "--name", "reviewer-pass", "--verdict", vf], { env: dispatcherEnv(sb), fetchImpl: fake.impl })).code,
    ).toBe(64);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("review post-check: dispatcher posting", () => {
  it.each([
    ["pass", "success"],
    ["block", "failure"],
    ["neutral", "neutral"],
  ])("verdict %s → a %s check-run, minted from the REVIEWER App, summary carries the panel receipt id", async (verdict, conclusion) => {
    const sb = sandbox();
    const fake = fakeGithub({ "2002": REVIEWER_TOKEN, "2001": AGENT_TOKEN });
    const vf = verdictFile(sb, { verdict, receipt_id: "panel-receipt-77", summary: "2 lenses ran" });
    const r = await reviewVerb(args(vf, "charter-class"), { env: dispatcherEnv(sb), fetchImpl: fake.impl });
    expect(r.code).toBe(0);
    const mint = fake.calls.filter((c) => c.url.includes("/access_tokens"));
    expect(mint.map((c) => c.url)).toEqual(["https://api.github.com/app/installations/2002/access_tokens"]); // reviewer, never agent
    const post = fake.calls.find((c) => c.url === "https://api.github.com/repos/o/r/check-runs")!;
    expect(post.method).toBe("POST");
    expect(post.headers.Authorization === `Bearer ${REVIEWER_TOKEN}`).toBe(true);
    const body = JSON.parse(post.body!);
    expect(body).toMatchObject({ name: "charter-class", head_sha: SHA, status: "completed", conclusion, external_id: "panel-receipt-77" });
    expect(body.output.summary).toContain("panel-receipt-77");
    expect(r.json).toMatchObject({ ok: true, check_run_id: 4242, conclusion, name: "charter-class", repo: "o/r", sha: SHA, app: "test-amico-reviewer" });
    expect(JSON.stringify(r.json).includes(REVIEWER_TOKEN)).toBe(false);
  });
  it("a rejected post → token-free failure naming the status, even when GitHub's body echoes the token", async () => {
    const sb = sandbox();
    const fake = fakeGithub({ "2002": REVIEWER_TOKEN }, { checkRunStatus: 403, errorBody: { message: `bad ${REVIEWER_TOKEN}` } });
    const vf = verdictFile(sb, { verdict: "neutral", receipt_id: "p" });
    const r = await reviewVerb(args(vf), { env: dispatcherEnv(sb), fetchImpl: fake.impl });
    expect(r.code).toBe(1);
    const s = JSON.stringify(r.json);
    expect(s).toMatch(/HTTP 403/);
    expect(s.includes(REVIEWER_TOKEN)).toBe(false);
  });
  it("no reviewer.json → exit 64, actionable, no fetch", async () => {
    const sb = sandbox({ reviewerJson: false });
    const fake = fakeGithub({ "2002": REVIEWER_TOKEN });
    const vf = verdictFile(sb, { verdict: "pass", receipt_id: "p" });
    const r = await reviewVerb(args(vf), { env: dispatcherEnv(sb), fetchImpl: fake.impl });
    expect(r.code).toBe(64);
    expect(JSON.stringify(r.json)).toMatch(/reviewer\.json/);
    expect(fake.calls).toHaveLength(0);
  });
});
