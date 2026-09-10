// #955 (the hub cutover's production service runner): headless orchestration
// tests for the amicode service runner — one long-lived process that spawns
// the vendored engine (password-armed, the ServerManager/probe mint idiom)
// and boots the amicode service (createAmicodeService — the SAME wiring
// startAmicodeService uses) against the app shelf, then stays alive.
//
// Two groups:
//  - LIVE (env-gated, the boot-probe convention): with a real vendored engine
//    binary AND a built app dist present, boot the REAL runner end-to-end and
//    assert the six probe surfaces through the runner's own orchestration
//    (the #823 boot-proof vocabulary), the OPENCODE_DB pin passthrough, and
//    graceful teardown. CI has neither artifact → skips honestly.
//  - FAIL-LOUD (always on): a missing engine binary, a shelf without an app
//    dist, and an engine that never becomes healthy each fail with a NAMED
//    reason (never a silent half-boot) and tear the spawned child down.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import {
  AmicodeServiceRunnerError,
  bootAmicodeServiceRunner,
  type AmicodeServiceRunnerBoot,
} from "../src/amicode_service_runner";
import { APP_SHELF_NEEDS_SETUP_MARKER } from "../src/amicode_service/app_shelf";
import { serverAuthHeader, serverAuthToken } from "../src/server_auth";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_BIN = join(PKG_ROOT, "vendor", "opencode", `${process.platform}-${process.arch}`, "opencode");
const APP_DIST = join(PKG_ROOT, "dist", "app");

const engineAvailable = existsSync(ENGINE_BIN);
const distAvailable = existsSync(join(APP_DIST, "index.html"));

describe.skipIf(!engineAvailable || !distAvailable)(
  "amicode service runner (live: vendored engine + built dist)",
  () => {
    const boots: AmicodeServiceRunnerBoot[] = [];
    afterAll(async () => {
      for (const b of boots.splice(0)) await b.shutdown().catch(() => undefined);
    });

    it("a busy fixed service port falls back to ephemeral and still boots the pair", async () => {
      // Pins the #955 fix: start() must leave no instance state behind on a
      // listen failure, or the fallback dies on "already running".
      const busy = createServer();
      await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", resolve));
      const busyPort = (busy.address() as { port: number }).port;
      try {
        const boot = await bootAmicodeServiceRunner({
          engineBin: ENGINE_BIN,
          appDistRoot: APP_DIST,
          servicePort: busyPort,
          enginePort: 0,
          log: () => undefined,
        });
        boots.push(boot);
        expect(boot.url).not.toContain(`:${busyPort}`);
        const probe = await fetch(`${boot.url}/amicode/profile`, {
          headers: { Authorization: serverAuthHeader(boot.enginePassword) },
        });
        expect(probe.status).toBe(200);
      } finally {
        busy.close();
      }
    }, 60_000);

    it("boots engine + service and answers the six probe surfaces through the runner's orchestration", async () => {
      const dbPath = join(mkdtempSync(join(tmpdir(), "amicode-runner-test-")), "runner-test.db");
      const boot = await bootAmicodeServiceRunner({
        engineBin: ENGINE_BIN,
        appDistRoot: APP_DIST,
        engineEnv: { OPENCODE_DB: dbPath },
        healthTimeoutMs: 30_000,
        servicePort: 0,
        enginePort: 0,
        log: () => undefined,
      });
      boots.push(boot);

      // The OPENCODE_DB pin reached the spawned engine: the engine migrated
      // its DB into the file WE named (the canonical-pin passthrough).
      expect(existsSync(dbPath), "engine did not create the OPENCODE_DB-pinned file").toBe(true);

      const origin = boot.url;
      const engineAuth = serverAuthHeader(boot.enginePassword);

      // 1. the app document from the shelf (200 text/html, NOT the placeholder)
      const doc = await fetch(`${origin}/`, { headers: { Authorization: engineAuth, Accept: "text/html" } });
      const docBody = await doc.text();
      expect(doc.status).toBe(200);
      expect(doc.headers.get("content-type") ?? "").toContain("text/html");
      expect(docBody.includes(APP_SHELF_NEEDS_SETUP_MARKER)).toBe(false);

      // 2. the BOOTSTRAP: ?auth_token= carrier, no header — the iframe carriage
      const bootstrap = await fetch(`${origin}/?auth_token=${encodeURIComponent(serverAuthToken(boot.enginePassword))}`, {
        headers: { Accept: "text/html" },
      });
      expect(bootstrap.status).toBe(200);
      expect((await bootstrap.text()).includes(APP_SHELF_NEEDS_SETUP_MARKER)).toBe(false);

      // 3. an ANONYMOUS asset fetch (the browser sub-resource constraint)
      const assetsDir = join(APP_DIST, "assets");
      const assetName = readdirSync(assetsDir).find((f) => f.endsWith(".js"));
      expect(assetName).toBeDefined();
      const asset = await fetch(`${origin}/assets/${assetName}`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type") ?? "").toContain("javascript");

      // 4. an engine API call through the proxy (the real engine's answer)
      const session = await fetch(`${origin}/session`, { headers: { Authorization: engineAuth } });
      expect(session.status).toBe(200);
      expect(session.headers.get("content-type") ?? "").toContain("application/json");

      // 5. an SSE connect through the proxy (first chunk delivered)
      const sse = await fetch(`${origin}/event`, { headers: { Authorization: engineAuth } });
      expect(sse.status).toBe(200);
      expect(sse.headers.get("content-type") ?? "").toContain("text/event-stream");
      {
        const reader = sse.body!.getReader();
        const { value } = await reader.read();
        expect(value && value.length > 0).toBe(true);
        await reader.cancel().catch(() => undefined);
      }

      // 6. one /amicode/* route with the ENGINE credential (accept-both auth)
      const profile = await fetch(`${origin}/amicode/profile`, { headers: { Authorization: engineAuth } });
      expect(profile.status).toBe(200);
      expect(((await profile.json()) as { ok?: boolean }).ok).toBe(true);

      const shutdown = boot.shutdown();
      await shutdown;
      // Teardown is REAL: the engine child is gone (the SIGKILL fallback bounds it).
      await new Promise((r) => setTimeout(r, 100));
      expect(boot.engine.exitCode !== null || boot.engine.signalCode !== null || boot.engine.killed).toBe(true);
    }, 60_000);
  },
);

describe.skipIf(!engineAvailable || !distAvailable)(
  "amicode service runner, UNARMED posture (live: vendored engine + built dist)",
  () => {
    const boots: AmicodeServiceRunnerBoot[] = [];
    afterAll(async () => {
      for (const b of boots.splice(0)) await b.shutdown().catch(() => undefined);
    });

    it("boots the unarmed pair and an anonymous proxied GET answers 200 (the hub posture pair)", async () => {
      const dbPath = join(mkdtempSync(join(tmpdir(), "amicode-runner-unarmed-")), "unarmed-test.db");
      // The hub posture is a PAIR: unarmed engine (#955) + open service auth
      // (AMICODE_SERVICE_AUTH=open, #959's env carrier — the runner passes
      // authMode resolution through to createAmicodeService independently).
      const prevAuth = process.env.AMICODE_SERVICE_AUTH;
      process.env.AMICODE_SERVICE_AUTH = "open";
      let boot: AmicodeServiceRunnerBoot;
      try {
        boot = await bootAmicodeServiceRunner({
          engineBin: ENGINE_BIN,
          appDistRoot: APP_DIST,
          engineEnv: { OPENCODE_DB: dbPath },
          engineUnarmed: true,
          healthTimeoutMs: 30_000,
          servicePort: 0,
          enginePort: 0,
          log: () => undefined,
        });
      } finally {
        if (prevAuth === undefined) delete process.env.AMICODE_SERVICE_AUTH;
        else process.env.AMICODE_SERVICE_AUTH = prevAuth;
      }
      boots.push(boot);

      // No engine credential exists in this posture.
      expect(boot.enginePassword).toBeUndefined();

      // The app-proxy forwards the request VERBATIM (no header injection), so
      // the anonymous GET reaches the UNARMED engine — the fork hub's
      // deployed "canonical serves anonymous 200" posture (2026-08-07).
      const session = await fetch(`${boot.url}/session`);
      expect(session.status).toBe(200);
      expect(session.headers.get("content-type") ?? "").toContain("application/json");
    }, 60_000);
  },
);

describe("amicode service runner spawn posture (headless, fake engine — no vendored engine needed)", () => {
  const boots: AmicodeServiceRunnerBoot[] = [];
  afterAll(async () => {
    for (const b of boots.splice(0)) await b.shutdown().catch(() => undefined);
  });

  /** A stand-in engine binary (the shebang-node fake-engine idiom): answers
   *  the health probe with 200 and — when FAKE_ENGINE_DUMP is set in its env
   *  (rides the runner's engineEnv passthrough) — records whether
   *  OPENCODE_SERVER_PASSWORD was present at spawn. argv: [node, script,
   *  "serve", "--port", <port>]. */
  function writeFakeEngine(dir: string): string {
    const bin = join(dir, "fake-engine");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const { createServer } = require("node:http");
const { writeFileSync } = require("node:fs");
const port = Number(process.argv[4] ?? 0);
if (process.env.FAKE_ENGINE_DUMP)
  writeFileSync(process.env.FAKE_ENGINE_DUMP, JSON.stringify({ armed: "OPENCODE_SERVER_PASSWORD" in process.env }));
createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("fake engine up");
}).listen(port, "127.0.0.1");
`,
    );
    chmodSync(bin, 0o755);
    return bin;
  }

  function writeStubShelf(dir: string): string {
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>stub shelf</title>");
    return dir;
  }

  it("UNARMED spawn: the child env carries NO OPENCODE_SERVER_PASSWORD, the service gets enginePassword: undefined, and the boot line names the posture", async () => {
    const dir = mkdtempSync(join(tmpdir(), "amicode-runner-unarmed-headless-"));
    const dump = join(dir, "env-dump.json");
    const lines: string[] = [];
    const boot = await bootAmicodeServiceRunner({
      engineBin: writeFakeEngine(dir),
      appDistRoot: writeStubShelf(mkdtempSync(join(tmpdir(), "amicode-runner-unarmed-shelf-"))),
      engineUnarmed: true,
      engineEnv: { FAKE_ENGINE_DUMP: dump },
      healthTimeoutMs: 10_000,
      servicePort: 0,
      enginePort: 0,
      log: (l) => lines.push(l),
    });
    boots.push(boot);

    // The spawn env, as seen BY THE CHILD (not inferred): the key is absent.
    const dumped = JSON.parse(readFileSync(dump, "utf8")) as { armed: boolean };
    expect(dumped.armed).toBe(false);

    // The service wiring: no engine mint handed over.
    expect(boot.enginePassword).toBeUndefined();

    // The posture is named on the boot line, per the hub ops contract.
    expect(lines.join("\n")).toContain("UNARMED (the hub's anonymous boundary posture)");

    // The service itself still boots and answers with its OWN mint (its
    // authMode resolves independently — credential default here, since the
    // hub's AMICODE_SERVICE_AUTH=open is the ops layer's env decision).
    const doc = await fetch(`${boot.url}/`, { headers: { Authorization: boot.authHeader } });
    expect(doc.status).toBe(200);
  }, 30_000);

  it("engineUnarmed wins over an explicit enginePassword — the posture is never silently half-armed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "amicode-runner-unarmed-wins-"));
    const dump = join(dir, "env-dump.json");
    const boot = await bootAmicodeServiceRunner({
      engineBin: writeFakeEngine(dir),
      appDistRoot: writeStubShelf(mkdtempSync(join(tmpdir(), "amicode-runner-unarmed-wins-shelf-"))),
      engineUnarmed: true,
      enginePassword: "explicit-but-ignored",
      engineEnv: { FAKE_ENGINE_DUMP: dump },
      healthTimeoutMs: 10_000,
      servicePort: 0,
      enginePort: 0,
      log: () => undefined,
    });
    boots.push(boot);
    const dumped = JSON.parse(readFileSync(dump, "utf8")) as { armed: boolean };
    expect(dumped.armed).toBe(false);
    expect(boot.enginePassword).toBeUndefined();
  }, 30_000);

  it("the DEFAULT (armed) path is unchanged: the child env DOES carry OPENCODE_SERVER_PASSWORD and the mint is surfaced", async () => {
    const dir = mkdtempSync(join(tmpdir(), "amicode-runner-armed-headless-"));
    const dump = join(dir, "env-dump.json");
    const boot = await bootAmicodeServiceRunner({
      engineBin: writeFakeEngine(dir),
      appDistRoot: writeStubShelf(mkdtempSync(join(tmpdir(), "amicode-runner-armed-shelf-"))),
      engineEnv: { FAKE_ENGINE_DUMP: dump },
      healthTimeoutMs: 10_000,
      servicePort: 0,
      enginePort: 0,
      log: () => undefined,
    });
    boots.push(boot);
    const dumped = JSON.parse(readFileSync(dump, "utf8")) as { armed: boolean };
    expect(dumped.armed).toBe(true);
    expect(typeof boot.enginePassword).toBe("string");
    expect((boot.enginePassword ?? "").length).toBeGreaterThan(0);
  }, 30_000);
});

describe("amicode service runner (fail-loud, headless — no engine needed)", () => {
  it("a missing engine binary fails with the named reason BEFORE spawning anything", async () => {
    const err = await bootAmicodeServiceRunner({
      engineBin: join(tmpdir(), "amicode-no-such-engine-bin"),
      appDistRoot: APP_DIST,
      servicePort: 0,
      enginePort: 0,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmicodeServiceRunnerError);
    expect((err as AmicodeServiceRunnerError).reason).toContain("no engine binary");
  });

  it("a shelf without a built app dist fails with the named reason", async () => {
    const empty = mkdtempSync(join(tmpdir(), "amicode-runner-empty-shelf-"));
    const err = await bootAmicodeServiceRunner({
      engineBin: ENGINE_BIN,
      appDistRoot: empty,
      servicePort: 0,
      enginePort: 0,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmicodeServiceRunnerError);
    expect((err as AmicodeServiceRunnerError).reason).toContain("no built app dist");
  });

  it("an engine that never becomes healthy fails with the named reason AND kills the spawned child", async () => {
    // A bin that hangs forever — the health wait must time out, name the
    // reason, and tear the child down (never a silent half-boot left behind).
    // The shelf is a stub (CI has no built dist): this test isolates the
    // engine-health path, so it must not depend on the shelf check passing.
    const stubShelf = mkdtempSync(join(tmpdir(), "amicode-runner-stub-shelf-"));
    writeFileSync(join(stubShelf, "index.html"), "<!doctype html><title>stub shelf</title>");
    const fakeBin = join(mkdtempSync(join(tmpdir(), "amicode-runner-fake-engine-")), "fake-engine");
    writeFileSync(fakeBin, "#!/bin/sh\nsleep 1000\n");
    chmodSync(fakeBin, 0o755);
    const err = await bootAmicodeServiceRunner({
      engineBin: fakeBin,
      appDistRoot: stubShelf,
      healthTimeoutMs: 1_500,
      servicePort: 0,
      enginePort: 0,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmicodeServiceRunnerError);
    expect((err as AmicodeServiceRunnerError).reason).toContain("engine not healthy");

    // The spawned child was torn down by the failing boot itself.
    const child = (err as AmicodeServiceRunnerError & { engine?: ReturnType<typeof spawn> }).engine;
    if (child !== undefined) {
      await new Promise((r) => setTimeout(r, 300));
      expect(child.killed || child.exitCode !== null || child.signalCode !== null).toBe(true);
    }
  });
});
