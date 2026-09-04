import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerManager } from "../src/server_manager";

// ============================================================================
// #781 AC3: the spawn error path must carry the ACTUAL cause, not just the
// generic "failed to start within 30s". ServerManager captures the child's
// output while spawning and attaches a tail to the failure error so the
// caller can match the known crash signature (e.g. a drifted local-DB
// migration). Success behavior is untouched (AC5 — existing tests cover it).
// ============================================================================

function captureChannel() {
  const lines: string[] = [];
  return {
    lines,
    channel: { appendLine: (l: string) => lines.push(l), append: (l: string) => lines.push(l) } as never,
  };
}

describe("ServerManager — spawn-output capture on failure (#781)", () => {
  it("fails fast — well inside the health budget — when the child crashes on startup, carrying the crash cause", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-781-fast-"));
    const bin = join(dir, "opencode");
    writeFileSync(
      bin,
      `#!/bin/sh\necho "opencode! Error: duplicate column name: directories" 1>&2\nexit 1\n`,
    );
    chmodSync(bin, 0o755);
    const { channel } = captureChannel();
    const manager = new ServerManager({
      binary: bin,
      cwd: dir,
      healthTimeoutMs: 30_000,
      env: {},
      channel,
    });
    const t0 = Date.now();
    const err = await manager.start().then(
      () => { throw new Error("expected start() to reject"); },
      (e: Error & { spawnOutput?: string }) => e,
    );
    // A crashed binary must not burn the full health budget before the
    // failure surfaces (AC1 — the window recovers promptly).
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(err.message).not.toMatch(/failed to start within/);
    expect(err.spawnOutput).toContain("duplicate column name: directories");
  });

  it("attaches the child's output tail to the thrown error when the server never becomes healthy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-781-"));
    // A fake `opencode` that crashes like the .18 vendored binary did on a
    // drifted local DB: prints the migration failure to stderr and dies.
    const bin = join(dir, "opencode");
    writeFileSync(
      bin,
      `#!/bin/sh\necho "opencode! Error: duplicate column name: directories" 1>&2\nexit 1\n`,
    );
    chmodSync(bin, 0o755);
    const { channel } = captureChannel();
    const manager = new ServerManager({
      binary: bin,
      cwd: dir,
      healthTimeoutMs: 5000,
      env: {},
      channel,
    });
    await expect(manager.start()).rejects.toMatchObject({
      spawnOutput: expect.stringContaining("duplicate column name: directories"),
    });
  });

  it("success path is unchanged — no error, URL returned (AC5)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-781-ok-"));
    const serverMjs = join(dir, "fake_serve.mjs");
    writeFileSync(
      serverMjs,
      `import http from "node:http";\nconst port = Number(process.argv[process.argv.indexOf("--port") + 1]);\nhttp.createServer((req, res) => res.end("ok")).listen(port, "127.0.0.1", () => console.log("fake opencode serving"));\n`,
    );
    const bin = join(dir, "opencode");
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${serverMjs}" "$@"\n`);
    chmodSync(bin, 0o755);
    const { channel } = captureChannel();
    const manager = new ServerManager({ binary: bin, cwd: dir, healthTimeoutMs: 5000, env: {}, channel });
    const url = await manager.start();
    expect(url.port).toBeTruthy();
    await manager.stop();
  });
});
