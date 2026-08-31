// Server-wiring test for the campaign routes (issue #658): the two GETs are
// registered on the extension-host service, served over HTTP with the same
// never-reject discipline as the problems/run-status family. The personal
// vault is a temp mount (AMICO_VAULTS_ROOT) with the trimmed REAL fixtures
// installed as session ledgers; nothing touches ~/.amico.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAmicodeService } from "../src/amicode_service";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/campaign/${name}`, import.meta.url));

describe("amicode service — campaign routes over HTTP", () => {
  let sandbox: string;
  let savedEnv: string | undefined;
  let service: ReturnType<typeof createAmicodeService>;
  let base: string;
  let auth: string;

  beforeAll(async () => {
    sandbox = mkdtempSync(join(tmpdir(), "amicode-campaign-wiring-"));
    mkdirSync(join(sandbox, "my-vault", "sessions"), { recursive: true });
    writeFileSync(join(sandbox, "my-vault", ".amico-vault.toml"), 'kind = "personal"\nname = "test"\n');
    copyFileSync(
      fixture("session-20260830-strumento-twins-bringup.trimmed.md"),
      join(sandbox, "my-vault", "sessions", "session-20260830-twins.md"),
    );
    copyFileSync(
      fixture("session-20260820-hrl-8dot-spin-mintime.straddle.md"),
      join(sandbox, "my-vault", "sessions", "session-20260820-hrl.md"),
    );
    savedEnv = process.env.AMICO_VAULTS_ROOT;
    process.env.AMICO_VAULTS_ROOT = sandbox;
    service = createAmicodeService({ password: "wiring-test-password" });
    const url = await service.start();
    base = url.toString().replace(/\/$/, "");
    auth = service.authHeader;
  });

  afterAll(async () => {
    await service.stop();
    if (savedEnv === undefined) delete process.env.AMICO_VAULTS_ROOT;
    else process.env.AMICO_VAULTS_ROOT = savedEnv;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("GET /amicode/campaigns serves the parsed list (newest first) from the personal vault", async () => {
    const r = await fetch(`${base}/amicode/campaigns`, { headers: { Authorization: auth } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.campaigns.map((c: any) => c.slug)).toEqual(["session-20260830-twins", "session-20260820-hrl"]);
    expect(body.campaigns[0]).toMatchObject({ campaign: "strumento-twins-bringup", status: "ACTIVE" });
  });

  it("GET /amicode/campaign?slug=… serves the structured sections", async () => {
    const r = await fetch(`${base}/amicode/campaign?slug=session-20260820-hrl`, { headers: { Authorization: auth } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.campaign.verdicts[1]![0]).toBe("H2");
    expect(body.campaign.loop_log_tail).toContain("pass-3 amendment"); // straddle recovered
    expect(body.campaign.compaction).not.toContain("|");
  });

  it("an unknown slug is an ok:false not_found BODY, not an HTTP 404", async () => {
    const r = await fetch(`${base}/amicode/campaign?slug=session-19990101-nope`, { headers: { Authorization: auth } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("not_found:session-19990101-nope");
  });

  it("the route table stays exact-match: /amicode/campaign-x is no route", async () => {
    const r = await fetch(`${base}/amicode/campaign-x`, { headers: { Authorization: auth } });
    expect(r.status).toBe(404);
  });

  it("a corrupt sessions dir (directory-as-file) still serves 200s — never a 500 (issue #658 AC)", async () => {
    mkdirSync(join(sandbox, "v", "sessions", "session-20260824-dir.md"), { recursive: true });
    const r1 = await fetch(`${base}/amicode/campaigns`, { headers: { Authorization: auth } });
    expect(r1.status).toBe(200);
    expect((await r1.json()).ok).toBe(true);
    const r2 = await fetch(`${base}/amicode/campaign?slug=session-20260824-dir`, { headers: { Authorization: auth } });
    expect(r2.status).toBe(200);
    expect((await r2.json()).ok).toBe(false); // not_found body, never a 500
  });
});
