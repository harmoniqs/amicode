import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerManager } from "../src/server_manager";
import { mintServerPassword, serverAuthHeader, serverAuthToken, buildServerSpawnEnv } from "../src/server_auth";

// ============================================================================
// #163: ServerManager injects OPENCODE_SERVER_PASSWORD into the spawn — so its
// OWN health probe must authenticate, or the fork 401s `GET /` and a perfectly
// healthy boot reads "did not become healthy within 30s". Integration-style
// against a REAL spawn of a fake `opencode serve` (a script that records each
// request's Authorization header to a file — never to stdout, mirroring the
// real binary which never prints its env), plus the AC3 scan: everything the
// manager writes to the output channel is captured and swept for the secret.
// ============================================================================

/** A fake `opencode` binary: shell shim → node http server on --port that
 *  appends {url, authorization} per request to `captureFile` and 200s. */
function fakeOpencodeBinary(dir: string, captureFile: string): string {
  const serverMjs = join(dir, "fake_serve.mjs");
  writeFileSync(
    serverMjs,
    [
      `import http from "node:http";`,
      `import { appendFileSync } from "node:fs";`,
      `const port = Number(process.argv[process.argv.indexOf("--port") + 1]);`,
      `http.createServer((req, res) => {`,
      `  appendFileSync(${JSON.stringify(captureFile)}, JSON.stringify({ url: req.url, authorization: req.headers.authorization ?? null }) + "\\n");`,
      `  res.end("ok");`,
      `}).listen(port, "127.0.0.1", () => console.log("fake opencode serving"));`,
    ].join("\n"),
  );
  const bin = join(dir, "opencode");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${serverMjs}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function captureChannel() {
  const lines: string[] = [];
  return {
    lines,
    channel: { appendLine: (l: string) => lines.push(l), append: (l: string) => lines.push(l) } as never,
  };
}

describe("ServerManager — health probe under the per-boot password (#163)", () => {
  it("authenticates its own probe with the credential it injected (AC2) and never logs the secret (AC3)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-auth-"));
    const captureFile = join(dir, "requests.jsonl");
    const password = mintServerPassword();
    const { lines, channel } = captureChannel();
    const manager = new ServerManager({
      binary: fakeOpencodeBinary(dir, captureFile),
      cwd: dir,
      // The REAL spawn-env builder — the probe must derive its credential from
      // the same env the child gets, so the two can never drift.
      env: buildServerSpawnEnv({ amicoRunBinDir: undefined, configContent: "{}", serverPassword: password }),
      channel,
    });
    try {
      await manager.start();
    } finally {
      await manager.stop();
    }
    const probes = readFileSync(captureFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { url: string; authorization: string | null });
    expect(probes.length).toBeGreaterThan(0);
    // EVERY probe carried the matching Basic credential — a 401'd first poll
    // would still pass a some() assertion, so pin all of them.
    for (const p of probes) expect(p.authorization).toBe(serverAuthHeader(password));
    // AC3: the channel captured the whole boot (spawn line, child stdout,
    // ready line) and the secret appears in none of it, in no encoding.
    const text = lines.join("\n");
    expect(text).toContain("fake opencode serving"); // child stdout really flowed through
    expect(text).toMatch(/\[server\] ready at http:\/\/127\.0\.0\.1:\d+/);
    expect(text).not.toContain(password);
    expect(text).not.toContain(serverAuthToken(password));
  }, 15_000);

  it("probes without a header when no password is in the spawn env (dev override path unchanged)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-noauth-"));
    const captureFile = join(dir, "requests.jsonl");
    const { channel } = captureChannel();
    const manager = new ServerManager({
      binary: fakeOpencodeBinary(dir, captureFile),
      cwd: dir,
      env: { PATH: process.env.PATH ?? "" },
      channel,
    });
    try {
      await manager.start();
    } finally {
      await manager.stop();
    }
    expect(existsSync(captureFile)).toBe(true);
    const probes = readFileSync(captureFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { authorization: string | null });
    for (const p of probes) expect(p.authorization).toBeNull();
  }, 15_000);
});
