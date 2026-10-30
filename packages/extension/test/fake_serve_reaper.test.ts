// fake_serve_reaper.test.ts — #1782: the server lifecycle tests spawn detached
// `fake_serve.mjs` servers (each holding an ephemeral 127.0.0.1 port). They must
// be REAPED after every test — including when an assertion fails before the
// test's own cleanup line — or they accumulate across `pnpm test` runs and
// poison engine server tests on macOS (a wildcard bind can be handed a port a
// stray 127.0.0.1 listener already holds).
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeServeShim, reapFakeServes, FAKE_SERVE_PID_FILE } from "./fake_serve_reaper";

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (cond: () => boolean, ms = 5000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
};

/** A detached fake server started through the shared shim, left running. */
function leakOne(): { dir: string; pid: number } {
  const dir = mkdtempSync(join(tmpdir(), "amc-1782-"));
  const serverMjs = join(dir, "fake_serve.mjs");
  writeFileSync(
    serverMjs,
    `import http from "node:http"; http.createServer((_, res) => res.end("ok")).listen(0, "127.0.0.1");`,
  );
  const bin = join(dir, "opencode");
  writeFileSync(bin, fakeServeShim(dir, serverMjs));
  chmodSync(bin, 0o755);
  const child = spawn(bin, [], { detached: true, stdio: "ignore" });
  child.unref();
  return { dir, pid: child.pid! };
}

describe("reapFakeServes (#1782)", () => {
  afterEach(() => reapFakeServes());

  it("kills a detached fake server a test left running", async () => {
    const { dir, pid } = leakOne();
    expect(await until(() => existsSync(join(dir, FAKE_SERVE_PID_FILE)))).toBe(true);
    const recorded = Number(readFileSync(join(dir, FAKE_SERVE_PID_FILE), "utf8").trim());
    expect(recorded).toBe(pid); // the shim exec()s, so $$ is the server's own pid
    expect(isAlive(pid)).toBe(true);

    await reapFakeServes();
    expect(await until(() => !isAlive(pid))).toBe(true);
  });

  it("only kills what the shim recorded — a recycled/foreign pid in the file is left alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "amc-1782-foreign-"));
    const serverMjs = join(dir, "fake_serve.mjs");
    writeFileSync(serverMjs, "");
    fakeServeShim(dir, serverMjs); // registers the dir
    const bystander = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      writeFileSync(join(dir, FAKE_SERVE_PID_FILE), `${bystander.pid}\n`);
      await reapFakeServes();
      expect(isAlive(bystander.pid!)).toBe(true);
    } finally {
      bystander.kill("SIGKILL");
    }
  });

  it("is a no-op when nothing was registered / the pid file is absent", async () => {
    await expect(reapFakeServes()).resolves.toBeUndefined();
  });
});

describe("every suite that spawns fake_serve.mjs reaps it (#1782)", () => {
  it("each such test file imports the reaper and runs it after each test", () => {
    const dir = __dirname;
    const spawners = readdirSync(dir)
      .filter((f) => f.endsWith(".test.ts") && f !== "fake_serve_reaper.test.ts")
      .filter((f) => readFileSync(join(dir, f), "utf8").includes("fake_serve.mjs"));
    expect(spawners.sort()).toEqual([
      "server_daemonize.test.ts",
      "server_detach.test.ts",
      "server_manager.test.ts",
      "server_manager_hub_ports.test.ts",
    ]);
    for (const f of spawners) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, `${f} imports the reaper`).toMatch(/from "\.\/fake_serve_reaper"/);
      expect(src, `${f} reaps after each test`).toMatch(/afterEach\(\(\) => reapFakeServes\(\)\)/);
    }
  });
});
