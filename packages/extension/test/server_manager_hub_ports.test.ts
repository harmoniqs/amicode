// #1760 P4 — the reserved hub port guard at the SPAWN choke point.
// Nothing the extension starts may ever bind 4094-4097 (the hub plane's
// ports: the runner's engine upstream 4094, the hub's amicode service 4095,
// the frontdoor 4096/4097) unless it IS the real hub — and the extension
// never is. The observed failure this kills: a Machine-settings pin of
// amicode.opencodePort=4094 on the hub host races the hub's own engine
// socket (the erlich three-bounce pattern).
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerManager } from "../src/server_manager";
import { isReservedHubPort, RESERVED_HUB_PORTS } from "../src/hub_client";

/** A fake `opencode` binary: shell shim → node http server on --port that
 *  writes its argv to `argsFile` and responds 200 (the server_detach idiom). */
function fakeOpencodeBinary(dir: string, argsFile: string): string {
  const serverMjs = join(dir, "fake_serve.mjs");
  writeFileSync(
    serverMjs,
    [
      `import http from "node:http";`,
      `import { writeFileSync } from "node:fs";`,
      `writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv) + "\\n");`,
      `const portIdx = process.argv.indexOf("--port");`,
      `const port = portIdx >= 0 ? Number(process.argv[portIdx + 1]) : 0;`,
      `http.createServer((req, res) => res.end("ok")).listen(port, "127.0.0.1");`,
    ].join("\n"),
  );
  const bin = join(dir, "opencode");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${serverMjs}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe("ServerManager — the reserved hub port guard (#1760 P4 requirement 3)", () => {
  it("refuses a pinned reserved hub port: the spawn lands on a non-reserved port, with the named log line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-hubport-"));
    const argsFile = join(dir, "argv.json");
    const logFile = join(dir, "server.log");
    const lines: string[] = [];
    const manager = new ServerManager({
      binary: fakeOpencodeBinary(dir, argsFile),
      cwd: dir,
      // The hostile pin: the frontdoor's own port.
      port: 4096,
      env: { PATH: process.env.PATH ?? "" },
      channel: { appendLine: (l: string) => lines.push(l), append: (l: string) => lines.push(l) } as never,
      logFile,
    });
    try {
      await manager.start();
    } finally {
      await manager.stop();
    }
    // The spawn actually bound a NON-reserved port (never 4094-4097)…
    expect(existsSync(argsFile)).toBe(true);
    const argv: string[] = JSON.parse(readFileSync(argsFile, "utf8").trim());
    const portIdx = argv.indexOf("--port");
    expect(portIdx).toBeGreaterThanOrEqual(0);
    const boundPort = Number(argv[portIdx + 1]);
    expect(isReservedHubPort(boundPort)).toBe(false);
    expect(boundPort).toBeGreaterThan(0);
    // …and the refusal is NAMED in the log, never silent.
    expect(lines.join("\n")).toContain("amicode.opencodePort = 4096");
    expect(lines.join("\n")).toContain("reserved hub");
  }, 20_000);

  it("an OS-picked free port never lands in the reserved range either (belt and braces)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-hubport-free-"));
    const argsFile = join(dir, "argv.json");
    const logFile = join(dir, "server.log");
    const manager = new ServerManager({
      binary: fakeOpencodeBinary(dir, argsFile),
      cwd: dir,
      env: { PATH: process.env.PATH ?? "" },
      channel: { appendLine: () => {}, append: () => {} } as never,
      logFile,
    });
    try {
      await manager.start();
    } finally {
      await manager.stop();
    }
    const argv: string[] = JSON.parse(readFileSync(argsFile, "utf8").trim());
    const portIdx = argv.indexOf("--port");
    expect(RESERVED_HUB_PORTS as readonly number[]).not.toContain(Number(argv[portIdx + 1]));
  }, 20_000);
});
