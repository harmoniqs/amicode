// amicode-service connections unit tests (#451, M1 slice 6) — the shapes the
// golden fixtures cannot pin: the /amicode/connections/auth route and the
// token auth_methods entry both landed in fork source AFTER the vendored pin
// (v1.18.10-amicode.11), so the recorded binary serves the SPA catch-all for
// them. These tests pin the ported SOURCE behavior; both join the golden arc
// at the next pin bump.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { startAuthResponse } from "../src/amicode_service/connections";

const SLACK_APP_FILE = join(homedir(), ".amico", "slack-app.json");
const SLACK_APP_BAK = SLACK_APP_FILE + ".test-bak";

describe("startAuthResponse — refusal shapes (post-pin route, source-level parity)", () => {
  let savedEnvId: string | undefined;
  let savedEnvSecret: string | undefined;
  let hadFile = false;

  beforeEach(() => {
    // Isolate from real Slack App config on the test machine
    savedEnvId = process.env.AMICODE_SLACK_CLIENT_ID;
    savedEnvSecret = process.env.AMICODE_SLACK_CLIENT_SECRET;
    delete process.env.AMICODE_SLACK_CLIENT_ID;
    delete process.env.AMICODE_SLACK_CLIENT_SECRET;
    hadFile = existsSync(SLACK_APP_FILE);
    if (hadFile) renameSync(SLACK_APP_FILE, SLACK_APP_BAK);
  });

  afterEach(() => {
    if (savedEnvId !== undefined) process.env.AMICODE_SLACK_CLIENT_ID = savedEnvId;
    else delete process.env.AMICODE_SLACK_CLIENT_ID;
    if (savedEnvSecret !== undefined) process.env.AMICODE_SLACK_CLIENT_SECRET = savedEnvSecret;
    else delete process.env.AMICODE_SLACK_CLIENT_SECRET;
    if (hadFile && existsSync(SLACK_APP_BAK)) renameSync(SLACK_APP_BAK, SLACK_APP_FILE);
  });

  it("slack browser auth without client_id returns setup instructions", async () => {
    const body = await startAuthResponse(JSON.stringify({ id: "slack", method: "browser" }));
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("slack_app_not_configured");
  });

  it("bad body refuses", async () => {
    const body = await startAuthResponse(JSON.stringify({}));
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("body must be JSON {id, method}");
  });

  it("bad method refuses", async () => {
    const body = await startAuthResponse(JSON.stringify({ id: "google", method: "carrier-pigeon" }));
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("method must be browser or device-code");
  });

  it("non-JSON body refuses", async () => {
    const body = await startAuthResponse("not json");
    expect(JSON.parse(body).ok).toBe(false);
  });
});
