// Boot the vendored opencode binary ONCE against a synthesized project and probe
// the two surfaces the healthcheck needs: GET /event (the β.2 boot gate) AND the
// provider signal (GET /config/providers + /config). Returned as data so callers
// decide pass/fail — boot_smoke.mjs asserts the /event gate; healthcheck.mjs
// derives BOTH the opencode check and the creds check from a single boot (no
// second server, per review). NEVER returns a provider key (fetchProviderSignal
// strips at the boundary).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchProviderSignal } from "../src/llm_creds.mjs";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Absolute path to the vendored opencode binary for this platform/arch. */
export function vendoredOpencodeBin() {
  const key = `${process.platform}-${process.arch}`;
  return join(PKG_ROOT, "vendor", "opencode", key, "opencode");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });
}

/**
 * Boot opencode once and probe it.
 * @returns {Promise<{ binMissing?: boolean, up: boolean, eventOk: boolean,
 *   eventStatus?: number, eventCtype?: string, signal?: object, log: string }>}
 * `signal` is the fetchProviderSignal result (key-free). On a boot failure the
 * remaining fields explain why.
 */
export async function bootOpencodeAndProbe({ bin = vendoredOpencodeBin(), timeoutMs = 30000 } = {}) {
  if (!existsSync(bin)) return { binMissing: true, up: false, eventOk: false, log: `vendored binary missing at ${bin}` };

  const proj = mkdtempSync(join(tmpdir(), "amicode-probe-"));
  mkdirSync(join(proj, ".opencode"), { recursive: true });
  writeFileSync(join(proj, "AGENTS.md"), "# Amicode probe\n");
  writeFileSync(
    join(proj, ".opencode", "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2),
  );

  const port = await freePort();
  let log = "";
  const child = spawn(bin, ["serve", "--port", String(port)], { cwd: proj, stdio: ["ignore", "pipe", "pipe"] });
  const onData = (d) => { log += d; };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  const cleanup = () => {
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
  };

  try {
    const deadline = Date.now() + timeoutMs;
    let up = false;
    while (Date.now() < deadline && !up) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
        if (r.status < 500) up = true;
      } catch { /* not up yet */ }
      if (!up) await new Promise((r) => setTimeout(r, 200));
    }
    if (!up) return { up: false, eventOk: false, log };

    // /event gate (headers only; SSE body streaming doesn't block us).
    let eventStatus, eventCtype, eventOk = false;
    try {
      const ev = await fetch(`http://127.0.0.1:${port}/event`, { signal: AbortSignal.timeout(10000) });
      eventStatus = ev.status;
      eventCtype = ev.headers.get("content-type") ?? "";
      eventOk = ev.status === 200 && eventCtype.includes("text/event-stream");
    } catch (e) {
      log += `\n/event probe error: ${String((e && e.message) || e)}`;
    }

    // provider signal off the SAME running server (key-free).
    const signal = await fetchProviderSignal(`http://127.0.0.1:${port}`);

    return { up: true, eventOk, eventStatus, eventCtype, signal, log };
  } finally {
    cleanup();
  }
}
