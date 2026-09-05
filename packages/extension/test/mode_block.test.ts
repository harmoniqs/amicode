// mode_block.test.ts — H4, the injection fixtures (#808, spec-20260905-063000
// D4): the `## Active mode` block the amicode_context plugin emits per
// request under `experimental.chat.system.transform`.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE SESSION-API AVAILABILITY FIXTURE RUNS FIRST (AC7) — describe order in
// this file is the gate: nothing below may consume the session-API path until
// describe "H4 FIRST" has proven (live, against the REAL vendored pinned
// binary in the REAL Bun runtime — not a mock of the loader's contract) that
// the plugin can resolve the session's agent via the engine client it holds →
// session.get → Session.Info.agent. Its outcome is recorded whichever way it
// decides:
//   - PRIMARY contract (all four facts hold): the block resolves postures via
//     session.get; the last-assistant-message fallback exists only for
//     non-compaction resolution failures and declines on a newer switch (the
//     monotonic message key, same store).
//   - INSUFFICIENT (any fact fails): per D4 NO widening executes — the
//     fallback-only contract applies with the unresolvable semantics
//     preserved, and the fixture's failure record is the artifact the harness
//     campaign's amendment decision consumes.
// When the vendored binary is absent (minimal CI before fetch:opencode) the
// fixture describe skips — loudly named below, never silently green.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(HERE, "..");
const OC_BIN = join(EXT, "vendor", "opencode", `${process.platform}-${process.arch}`, "opencode");
const PROBE_PLUGIN = join(HERE, "fixtures", "session_api_probe", "plugin.ts");

/** A free 127.0.0.1 port (the opencode_probe.mjs idiom). */
function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address() === null ? 0 : (srv.address() as { port: number }).port;
      srv.close(() => res(p));
    });
    srv.on("error", rej);
  });
}

interface ProbeLine {
  event: string;
  [k: string]: unknown;
}

function readProbeLines(out: string): ProbeLine[] {
  if (!existsSync(out)) return [];
  return readFileSync(out, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as ProbeLine);
}

// ─── H4 FIRST — the session-API availability fixture (AC7) ─────────────────
//
// Boots the pinned binary with OPENCODE_CONFIG_CONTENT registering the probe
// plugin (the same registration mechanism the extension uses for
// amicode_context.ts), a config-declared `autodev` director agent, and a
// fixture provider whose baseURL is a DEAD local port: model RESOLUTION is
// offline (config models are metadata), the transform hook fires in
// LLMRequestPrep.prepare BEFORE the provider SDK loads and before the network
// call, so the LLM roundtrip's guaranteed failure (connection refused) cannot
// mask the leg this fixture proves — the hook fires and resolves from INSIDE
// the transform, whatever the turn's fate.
describe.skipIf(!existsSync(OC_BIN))("H4 FIRST — the session-API availability fixture (gates every H4 cell below)", () => {
  it(
    "the transform hook resolves the session's agent via the engine client's session.get (the primary path, proven live)",
    async () => {
      const port = await freePort();
      const home = mkdtempSync(join(tmpdir(), "saf-home-"));
      const proj = mkdtempSync(join(tmpdir(), "saf-proj-"));
      const probeOut = join(home, "probe.jsonl");
      const serverLog = join(home, "server.log");
      mkdirSync(join(proj, ".opencode"), { recursive: true });
      writeFileSync(join(proj, "AGENTS.md"), "# fixture\n");
      writeFileSync(
        join(proj, ".opencode", "opencode.json"),
        JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2),
      );
      appendFileSync(probeOut, "");

      // The isolated config: probe plugin (abs path, the production
      // registration mechanism) + the fixture director agent + the dead-port
      // provider. No OPENCODE_DB / AMICO_FLEET_FALLBACK leak: the child env is
      // built fresh below.
      const configContent = JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        plugin: [PROBE_PLUGIN],
        agent: {
          autodev: {
            description: "the fixture director agent",
            prompt: "You are the fixture director. This turn's answer never matters.",
          },
        },
        provider: {
          fixtureprov: {
            npm: "@ai-sdk/openai-compatible",
            name: "Fixture",
            options: { baseURL: "http://127.0.0.1:9/v1" },
            models: { fixturemodel: { name: "Fixture Model" } },
          },
        },
        model: "fixtureprov/fixturemodel",
      });

      const child: ChildProcess = spawn(OC_BIN, ["serve", "--port", String(port)], {
        cwd: proj,
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          OPENCODE_CONFIG_CONTENT: configContent,
          AMICO_SESSION_API_PROBE_OUT: probeOut,
        },
      });
      let log = "";
      child.stderr?.on("data", (d) => {
        log += d;
        if (serverLog !== undefined) {
          try {
            appendFileSync(serverLog, d);
          } catch {}
        }
      });

      const kill = (): void => {
        try {
          child.kill("SIGTERM");
        } catch {}
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
        }, 3000).unref();
      };

      try {
        // (1) server up (the opencode_probe idiom)
        const deadline = Date.now() + 30_000;
        let up = false;
        while (Date.now() < deadline && !up) {
          try {
            const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
            if (r.status < 500) up = true;
          } catch {
            /* not up yet */
          }
          if (!up) await new Promise((r) => setTimeout(r, 200));
        }
        expect(up, `vendored binary did not serve within 30s\n--- server output ---\n${log}`).toBe(true);

        // (2) create the session ON the director agent (Session.CreateInput.agent).
        //     NOTE, recorded live: external plugin loading is INSTANCE-LAZY in the
        //     pinned binary — the plugin factory runs when the first session
        //     spins up the directory's instance, not at boot. The factory record
        //     is therefore asserted after the create, before the prompt.
        const created = await fetch(`http://127.0.0.1:${port}/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent: "autodev" }),
          signal: AbortSignal.timeout(10_000),
        });
        expect(created.status, `POST /session failed (${created.status})\n${log}`).toBe(200);
        const session = (await created.json()) as { id?: string; agent?: string };
        expect(typeof session.id).toBe("string");
        const sessionID = session.id!;
        // the wire contract's first leg: the session's own agent round-trips
        expect(session.agent, "GET /session response did not carry the created agent on the wire").toBe("autodev");

        // (3) the probe plugin LOADED with the session's instance and its
        //     factory got the engine client (the same PluginInput handoff
        //     amicode_tools.ts relies on in production).
        let lines = await waitFor(probeOut, (l) => l.event === "factory", 15_000);
        const factory = lines.find((l) => l.event === "factory")!;
        expect(factory, "the probe plugin never loaded — the factory record is absent").toBeTruthy();
        expect(factory.has_client, "the plugin factory input did NOT carry the engine client").toBe(true);
        expect(factory.has_get, "the engine client has no session.get callable").toBe(true);
        expect(factory.has_directory, "the plugin factory input did not carry the directory").toBe(true);

        // (4) prompt the session — the user message lands with agent=autodev,
        //     the LLM request prepares, the transform fires, the probe
        //     resolves session.get from INSIDE the hook. The turn itself then
        //     dies on the dead provider port (connection refused, retried) —
        //     the response only flushes its headers after the doomed retries,
        //     so the fetch is fired WITHOUT awaiting it: the transform is
        //     server-side and lands regardless of the response's fate. A
        //     malformed payload would 400 immediately and never fire the
        //     transform — the step-5 assertions name that failure mode.
        const promptFetch = fetch(`http://127.0.0.1:${port}/session/${sessionID}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            parts: [{ type: "text", text: "resolve the posture" }],
            agent: "autodev",
            model: { providerID: "fixtureprov", modelID: "fixturemodel" },
          }),
        });
        // never let the dangling fetch reject unhandled
        void promptFetch.then((r) => void r.body?.cancel()).catch(() => {});

        // (5) the hook fired with the session id and resolved the agent
        lines = await waitFor(probeOut, (l) => l.event === "resolve", 60_000);
        const transform = lines.find((l) => l.event === "transform");
        expect(transform, "the transform hook never fired — the hook input contract failed").toBeTruthy();
        expect((transform as ProbeLine).sessionID).toBe(sessionID);
        const resolution = lines.find((l) => l.event === "resolve")!;
        expect(
          resolution.ok,
          `session.get did not resolve inside the transform hook: ${String(resolution.reason)}`,
        ).toBe(true);
        expect(
          resolution.agent,
          "session.get returned but Session.Info.agent is absent — the primary path is insufficient",
        ).toBe("autodev");

        // (6) RECORD THE OUTCOME (AC7: whichever way it decides) — stdout
        // artifact for the slice record + the campaign ledger's O5 entry.
        const outcome = {
          fixture: "session-api-availability",
          issue: 808,
          binary: "vendored pinned (opencode.lock.json)",
          contract: "primary",
          facts: {
            factory_has_client: factory.has_client,
            hook_fires_with_sessionID: true,
            session_get_resolves_inside_hook: resolution.ok === true,
            info_agent_round_trips: resolution.agent === "autodev",
          },
        };
        console.log(`[session-api-fixture] OUTCOME ${JSON.stringify(outcome)}`);
      } finally {
        kill();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

/** Poll the probe JSONL until a line matching pred appears (or timeout). */
async function waitFor(out: string, pred: (l: ProbeLine) => boolean, ms: number): Promise<ProbeLine[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const lines = readProbeLines(out);
    if (lines.some(pred)) return lines;
    if (Date.now() > deadline) return lines; // the caller's find() reports the missing leg
    await new Promise((r) => setTimeout(r, 250));
  }
}
