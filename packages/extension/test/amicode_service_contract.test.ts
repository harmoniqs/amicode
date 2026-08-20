// Amicode-service contract test (#451, M1) — the parallel-run proof for every
// ported route family. Currently covered: /amicode/profile (slice 1) and the
// vault family (slice 2): /amicode/vaults GET+POST, /amicode/warrants,
// /amicode/approve, /amicode/vault-files, /amicode/vault-file,
// /amicode/resolve-file.
//
// Golden fixtures recorded from the FORK binary (scripts/record_amicode_fixtures.mjs,
// vendored pin v1.18.10-amicode.11) against the SAME seeded sandbox this test
// builds (scripts/amicode_fixture_seed.mjs). Replay each recorded request
// against the PORTED extension-host service and require deep-equal responses —
// fork and port serving identical bytes from identical state is the whole
// parity claim.
//
// Absolute paths differ between the recording sandbox and this test's sandbox;
// both sides are normalized to <SANDBOX> (meta.sandbox vs this sandbox, plus
// their realpath forms) before comparison. Everything else must match exactly.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedAmicodeSandbox } from "../scripts/amicode_fixture_seed.mjs";
import { createAmicodeService } from "../src/amicode_service";

const FIXTURE = fileURLToPath(new URL("./fixtures/amicode/golden.json", import.meta.url));
// Loaded at module scope: the it() cases are GENERATED at collection time,
// before beforeAll runs.
const META: { fork: { tag: string }; sandbox: string; sandboxReal: string; entries: any[] } =
  JSON.parse(readFileSync(FIXTURE, "utf8"));

describe("amicode service — golden-fixture parity with the fork", () => {
  let sandbox: string;
  let savedEnv: Record<string, string | undefined>;
  let service: ReturnType<typeof createAmicodeService>;
  let base: string;
  let auth: string;
  let meta = META;

  /** Normalize the sandbox roots (unresolved + realpath forms) to <SANDBOX>. */
  const normalize = (text: string, dirs: string[]): string => {
    let out = text;
    // longest first so the realpath form isn't partially eaten by the prefix
    for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
      if (d) out = out.split(d).join("<SANDBOX>");
    }
    return out;
  };

  beforeAll(async () => {
    meta = JSON.parse(readFileSync(FIXTURE, "utf8"));
    sandbox = mkdtempSync(join(tmpdir(), "amicode-parity-"));
    const { env } = seedAmicodeSandbox(sandbox);
    // Redirect every state root to the sandbox (the port resolves these at
    // call time). PATH is pinned to the seeded stub dir on BOTH sides (the
    // recorder pins it for the fork spawn) so `amico` is the stub and
    // `amico-vault` is never found — CLI behavior identical regardless of
    // what the host machine has installed.
    savedEnv = {};
    for (const k of [...Object.keys(env), "AMICO_VAULT_BIN", "AMICO_OPS", "AMICO_VAULT_BROWSER"]) {
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
    expect(meta.fork.tag).toBe("v1.18.10-amicode.11");
    expect(meta.entries.length).toBeGreaterThan(0);
  });

  for (const [i, entry] of meta.entries.entries()) {
    it(`[${i}] ${entry.request.method} ${entry.request.path.replace(/\?.*/, "")} — "${entry.name}"`, async () => {
      // {SANDBOX} substitution: recorded requests embed the RECORDING sandbox;
      // replay with THIS sandbox so stateful paths resolve here.
      const sub = (s: string) =>
        s.replaceAll("{SANDBOX}", sandbox).replaceAll(encodeURIComponent("{SANDBOX}"), encodeURIComponent(sandbox));
      const path = sub(entry.request.path);
      const body =
        entry.request.body === undefined
          ? undefined
          : typeof entry.request.body === "string"
            ? sub(entry.request.body)
            : JSON.stringify(
                JSON.parse(JSON.stringify(entry.request.body), (_k, v) => (typeof v === "string" ? sub(v) : v)),
              );
      const r = await fetch(base + path, {
        method: entry.request.method,
        headers: { Authorization: auth, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body,
      });
      expect(r.status).toBe(entry.status);
      const expected = normalize(entry.body, [meta.sandbox, meta.sandboxReal]);
      const received = normalize(await r.text(), [sandbox, realpathSync(sandbox)]);
      // Deep-equal on parsed JSON: key order in the serialized body is the
      // port's business, structure and values are the contract.
      expect(JSON.parse(received)).toEqual(JSON.parse(expected));
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
