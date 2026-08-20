// Amicode-service contract test (#451, M1 slice 1) — the parallel-run proof
// for /amicode/profile.
//
// Golden fixtures recorded from the FORK binary (scripts/record_amicode_fixtures.mjs,
// vendored pin v1.18.10-amicode.11) against the SAME seeded sandbox this test
// builds (scripts/amicode_fixture_seed.mjs). Replay each recorded request
// against the PORTED extension-host service and require deep-equal responses —
// fork and port serving identical bytes from identical state is the whole
// parity claim for this slice.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedAmicodeSandbox } from "../scripts/amicode_fixture_seed.mjs";
import { createAmicodeService } from "../src/amicode_service";

const FIXTURE = fileURLToPath(new URL("./fixtures/amicode/profile.json", import.meta.url));

describe("amicode service — /amicode/profile parity with the fork (golden fixtures)", () => {
  let sandbox: string;
  let savedEnv: Record<string, string | undefined>;
  let service: ReturnType<typeof createAmicodeService>;
  let base: string;
  let auth: string;

  beforeAll(async () => {
    sandbox = mkdtempSync(join(tmpdir(), "amicode-parity-"));
    const { env } = seedAmicodeSandbox(sandbox);
    // Redirect every state root to the sandbox (the port resolves these at
    // call time). AMICODE_MOUNTS_FILE is the port's test seam — the recorder
    // redirects HOME instead; both point at the same seeded file.
    savedEnv = {};
    for (const k of Object.keys(env)) {
      savedEnv[k] = process.env[k];
      process.env[k] = env[k];
    }
    service = createAmicodeService({ password: "contract-test-password" });
    const url = await service.start();
    base = url.toString().replace(/\/$/, "");
    auth = service.authHeader;
  });

  afterAll(async () => {
    await service.stop();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("fixtures were recorded from the expected fork pin", () => {
    const meta = JSON.parse(readFileSync(FIXTURE, "utf8"));
    expect(meta.fork.tag).toBe("v1.18.10-amicode.11");
    expect(meta.entries.length).toBeGreaterThan(0);
  });

  for (const [i, entry] of JSON.parse(readFileSync(FIXTURE, "utf8")).entries.entries()) {
    it(`[${i}] ${entry.request.method} ${entry.request.path} — "${entry.name}"`, async () => {
      const r = await fetch(base + entry.request.path, { method: entry.request.method, headers: { Authorization: auth } });
      expect(r.status).toBe(entry.status);
      // Deep-equal on parsed JSON: key order in the serialized body is the
      // port's business, structure and values are the contract.
      expect(await r.json()).toEqual(JSON.parse(entry.body));
    });
  }

  it("unauthenticated requests are rejected like the fork's auth layer", async () => {
    const r = await fetch(base + "/amicode/profile");
    expect(r.status).toBe(401);
  });

  it("unknown amicode paths 404 (the fork serves its app there; nothing should ask us)", async () => {
    const r = await fetch(base + "/amicode/no-such-route", { headers: { Authorization: auth } });
    expect(r.status).toBe(404);
  });
});
