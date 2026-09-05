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
// session.get → Session.Info.agent, and (A1, the PR #814 review fold) that
// the session.messages endpoint returns its array in ASCENDING message-id
// order with the per-message agent present — the exact facts
// fallbackResolve's array-order pick consumes. Its outcome is recorded
// whichever way it decides, DURABLY on both paths (A2: the record is computed
// from whatever probe records exist — the contract value is never hardcoded —
// and persisted under test/fixtures/session_api_probe/last-run/):
//   - PRIMARY contract (all facts hold): the block resolves postures via
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
// The PRODUCT context plugin rides the same boot (#808): if amicode_context.ts
// fails to LOAD under the pinned binary's Bun runtime (a broken sibling
// import, a bad transpile), every production chat dies. The fixture's boot
// registers BOTH the probe and the product plugin — the probe proves the
// contract, and the live boot additionally asserts exactly the LOAD: no
// "failed to load plugin" in the server log, with the probe's records still
// arriving after the product plugin registered FIRST in the array. The
// context plugin's own TRANSFORM path is NOT exercised by this boot (in the
// temp HOME it no-ops by design — no staged registry to read); that path is
// covered by the unit cells below, not the live fixture.
const CONTEXT_PLUGIN = join(EXT, "opencode-plugin", "amicode_context.ts");
// (A2) the durable artifact home for the fixture's outcome record — the
// probe JSONL, server log, and outcome JSON persist HERE (repo-level,
// gitignored via the fixtures dir's own .gitignore), so an INSUFFICIENT
// verdict leaves the D4 amendment decision its artifact instead of dying
// with the temp home.
const DURABLE_DIR = join(HERE, "fixtures", "session_api_probe", "last-run");

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
    "the transform hook resolves the session's agent via session.get, and session.messages' array order is ascending with the per-message agent on the wire (the primary path + the fallback's ordering fact, proven live)",
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
        plugin: [PROBE_PLUGIN, CONTEXT_PLUGIN],
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
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          OPENCODE_CONFIG_CONTENT: configContent,
          AMICO_SESSION_API_PROBE_OUT: probeOut,
        },
      });
      let log = "";
      child.stdout?.on("data", (d) => {
        log += d;
      });
      child.stderr?.on("data", (d) => {
        log += d;
        if (serverLog !== undefined) {
          try {
            appendFileSync(serverLog, d);
          } catch {}
        }
      });

      // (issue #830) The teardown must never be the flake. The vendored
      // binary's background package-install into the temp HOME outlives the
      // client shutdown; the old fire-and-forget kill (SIGTERM + an unref'd
      // SIGKILL timer) let it keep WRITING while the finally's recursive
      // rmdir ran — ENOTEMPTY on CI, reproduced twice on different subdirs
      // (zod/src/v3/tests, effect/dist/unstable), never on a warm local
      // run. Fix, both halves: (a) SEQUENTIAL shutdown awaited to process
      // exit — SIGTERM → bounded wait → SIGKILL → bounded wait — and (b) a
      // RETRYING rmSync (Node natively retries ENOTEMPTY/EBUSY per
      // maxRetries × retryDelay), bounding any residual grandchild writer.
      const waitForExit = (ms: number): Promise<boolean> =>
        new Promise((resolve) => {
          const done = child.exitCode !== null || child.signalCode !== null;
          if (done) {
            resolve(true);
            return;
          }
          const timer = setTimeout(() => {
            child.removeListener("exit", onExit);
            child.removeListener("error", onExit);
            resolve(false);
          }, ms);
          timer.unref?.();
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          child.once("exit", onExit);
          child.once("error", onExit);
        });
      const killAndWait = async (): Promise<void> => {
        try {
          child.kill("SIGTERM");
        } catch {}
        if (await waitForExit(10_000)) return;
        try {
          child.kill("SIGKILL");
        } catch {}
        await waitForExit(5_000);
      };

      // hoisted for the A2 finally: the outcome record is computed from the
      // probe's records whatever happened, and needs the session's id.
      let sessionID: string | null = null;

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
        sessionID = session.id!;
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
        expect(factory.has_messages, "the engine client has no session.messages callable (the A1 leg's transport)").toBe(true);
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

        // (6) (A1, PR #814 review fold) PIN THE MESSAGES-ORDERING FACT LIVE.
        //     fallbackResolve picks the LAST assistant message by ARRAY ORDER
        //     of session.messages — an assumption the unit cells can't check
        //     (their fakes are built ascending by construction). A future
        //     vendoring pin that flipped the endpoint's order would make the
        //     fallback silently read the OLDEST assistant message: a wrong
        //     posture with every unit cell green. So the live fixture fires a
        //     SECOND prompt (the doomed turn persists BOTH its user and
        //     assistant messages — the first is already in the store; the
        //     second adds a third record) and asserts the probe's observed
        //     stream: ids strictly ascending IN ARRAY ORDER, and the
        //     per-message agent present on the wire for both roles.
        const promptFetch2 = fetch(`http://127.0.0.1:${port}/session/${sessionID}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            parts: [{ type: "text", text: "resolve the posture, again" }],
            agent: "autodev",
            model: { providerID: "fixtureprov", modelID: "fixturemodel" },
          }),
        });
        void promptFetch2.then((r) => void r.body?.cancel()).catch(() => {});
        lines = await waitFor(
          probeOut,
          (l) => l.event === "messages" && Array.isArray(l.ids) && (l.ids as string[]).length >= 3,
          60_000,
        );
        const messagesRec = [...lines]
          .filter((l) => l.event === "messages" && Array.isArray(l.ids) && (l.ids as string[]).length >= 3)
          .at(-1);
        expect(
          messagesRec,
          "no session.messages record with >=3 messages arrived — the messages leg never fired",
        ).toBeTruthy();
        const mIds = (messagesRec as ProbeLine).ids as string[];
        const mRoles = ((messagesRec as ProbeLine).roles ?? []) as Array<string | null>;
        const mAgents = ((messagesRec as ProbeLine).agents ?? []) as Array<string | null>;
        expect((messagesRec as ProbeLine).ok, `the probe's session.messages leg failed: ${String((messagesRec as ProbeLine).reason)}`).toBe(true);
        // the ordering fact — re-derived from the RAW ids, not trusting the
        // probe's own flag (asserted separately below)
        for (let k = 1; k < mIds.length; k++) {
          expect(
            mIds[k - 1] < mIds[k],
            `session.messages ARRAY ORDER is not ascending: [${mIds.join(", ")}] — fallbackResolve would read the OLDEST assistant message, not the last (a wrong posture with every unit cell green)`,
          ).toBe(true);
        }
        expect((messagesRec as ProbeLine).ascending, "the probe's own ascending computation disagrees with the raw ids").toBe(true);
        // the per-message-agent fact: BOTH roles carry the agent on the wire
        // (the user messages the switch-decline rule reads, and the assistant
        // messages the fallback reads)
        expect(mRoles).toContain("user");
        expect(mRoles).toContain("assistant");
        expect(
          mAgents,
          "session.messages did not carry the per-message agent on the wire — the fallback's read data is absent",
        ).toEqual(mAgents.map(() => "autodev"));

        // (7) the PRODUCT context plugin LOADS cleanly under the pinned
        //     binary's Bun runtime (a broken sibling import or a bad
        //     transpile would log "failed to load plugin" here — the failure
        //     that kills every production chat), with the probe's records
        //     still arriving after it registered FIRST in the plugin array.
        //     Exactly what this asserts: the LOAD. The context plugin's own
        //     TRANSFORM path is NOT exercised by this boot (in the temp HOME
        //     it no-ops by design — no staged registry to read); that path
        //     is covered by the unit cells below, not the live fixture.
        expect(
          log,
          "a plugin failed to load under the pinned binary — the production registration would break every chat:\n" + log,
        ).not.toMatch(/failed to load (external )?plugin/i);
      } finally {
        // (8) (A2, PR #814 review fold) RECORD THE OUTCOME, DURABLY, ON BOTH
        //     PATHS. The contract value is COMPUTED from whatever probe
        //     records exist — never hardcoded — so a RED on any leg (this
        //     finally runs after it) leaves an honest `insufficient` record
        //     plus the probe JSONL and server log: the artifacts the D4
        //     amendment decision consumes. Everything persists to the
        //     repo-level gitignored dir (DURABLE_DIR) before the temp home
        //     dies, and the OUTCOME line is echoed for the slice record.
        const records = readProbeLines(probeOut);
        const factoryRec = records.find((l) => l.event === "factory");
        const transformRec = records.find((l) => l.event === "transform");
        const resolveRec = records.find((l) => l.event === "resolve");
        const messagesRecs = records.filter((l) => l.event === "messages" && Array.isArray(l.ids) && (l.ids as string[]).length > 0);
        const lastMessages = messagesRecs.at(-1);
        let idsAscending = false;
        if (lastMessages !== undefined) {
          const ids = lastMessages.ids as string[];
          idsAscending = ids.every((id, k) => k === 0 || ids[k - 1] < id);
        }
        const facts = {
          factory_has_client: factoryRec?.has_client === true,
          hook_fires_with_sessionID: typeof transformRec?.sessionID === "string" && transformRec.sessionID === sessionID,
          session_get_resolves_inside_hook: resolveRec?.ok === true,
          info_agent_round_trips: resolveRec?.agent === "autodev",
          messages_endpoint_ascending: idsAscending,
          per_message_agent_on_the_wire:
            lastMessages !== undefined &&
            Array.isArray(lastMessages.agents) &&
            (lastMessages.agents as Array<unknown>).length > 0 &&
            (lastMessages.agents as Array<unknown>).every((a) => a === "autodev"),
        };
        const outcome = {
          fixture: "session-api-availability",
          issue: 808,
          binary: "vendored pinned (opencode.lock.json)",
          contract: Object.values(facts).every((v) => v === true) ? "primary" : "insufficient",
          facts,
          records_seen: records.length,
          recorded_at: new Date().toISOString(),
        };
        try {
          mkdirSync(DURABLE_DIR, { recursive: true });
          writeFileSync(join(DURABLE_DIR, "outcome.json"), JSON.stringify(outcome, null, 2) + "\n");
          if (existsSync(probeOut)) writeFileSync(join(DURABLE_DIR, "probe.jsonl"), readFileSync(probeOut));
          writeFileSync(join(DURABLE_DIR, "server.log"), log);
        } catch (e) {
          console.error(`[session-api-fixture] durable record write failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        console.log(`[session-api-fixture] OUTCOME ${JSON.stringify(outcome)}`);
        await killAndWait();
        rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
        rmSync(proj, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      }
    },
    150_000,
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

// ═══════════════════════════════════════════════════════════════════════════
// H4 — the injection cells. The session-API availability fixture above ran
// FIRST and decided the contract (primary, all facts — session.get's
// resolution AND session.messages' ascending array order with the per-message
// agent on the wire; see the recorded OUTCOME line + the durable record under
// test/fixtures/session_api_probe/last-run/): the block resolves postures via
// the engine client's
// session.get; the last-assistant-message fallback exists only for runtime
// resolution failures (compaction is NOT one — session state survives
// compaction, and the fallback never fires for it by construction) and
// DECLINES wherever it would lie: an agent-switch record NEWER than the
// message it would read, newer on the MONOTONIC message id from the SAME
// store — never wall-clock (no timestamp is read anywhere), never prose
// matching (no message text is read anywhere).
//
// The cells below pin the D4 semantics against fakes shaped exactly like the
// contract the fixture proved (hey-api {data} envelopes and raw payload
// shapes both tolerated — the same defensive unwrap as session_spawn.ts).
// ═══════════════════════════════════════════════════════════════════════════

import {
  buildModeBlock,
  PLUGIN_SUPPORTED_MODE_BUNDLE_VERSION,
  compareModeVersionsPlugin,
  UNRESOLVABLE_HEADLINE,
} from "../opencode-plugin/mode_block";
import {
  generateLedgerDiscoveryRegion,
  checkConsumerFloor,
  compareModeVersions,
  SUPPORTED_MODE_BUNDLE_VERSION,
} from "@amicode/schema";

const UNRESOLVABLE_LINE = "posture: unresolvable — re-bind from the ledger";

/** A staged-registry fixture: one modes root, N bundles, each configurable.
 *  The card carries the REAL generated region byte-exact (the block reads the
 *  ledger-discovery rule from the staged card, never a hardcoded copy). */
function stagedRegistry(
  opts: {
    modes?: Array<{
      mode: string;
      agent?: string; // defaults to the mode name
      pluginFloor?: string;
      omitPack?: boolean;
      omitCard?: boolean;
      omitManifest?: boolean;
      tamperManifest?: boolean;
      omitRegion?: boolean; // card present, generated region absent
    }>;
  } = {},
): string {
  const modesRoot = mkdtempSync(join(tmpdir(), "mode-block-reg-"));
  const modes = opts.modes ?? [{ mode: "autodev" }, { mode: "autoresearch" }];
  for (const m of modes) {
    const dir = join(modesRoot, m.mode);
    mkdirSync(dir, { recursive: true });
    if (!m.omitManifest) {
      writeFileSync(
        join(dir, "mode.toml"),
        [
          'schema_version = "1"',
          `mode = "${m.mode}"`,
          `agent = "${m.agent ?? m.mode}"`,
          'card = "card.md"',
          'pack = "pack.toml"',
          `protocol_skills = ["director-core"]`,
          "",
          "[[roles]]",
          'name = "implementer"',
          'path = "../../agents/implementer.md"',
          "",
          "[[handoff_seeds]]",
          'kind = "issue_seed"',
          'schema = "../../handoff-seeds/issue-seed.schema.json"',
          "",
          "[consumer_floors]",
          'doctor = "1"',
          `plugin = "${m.pluginFloor ?? "1"}"`,
          'stager = "1"',
          'tests = "1"',
          ...(m.tamperManifest ? ["this is not toml ====="] : []),
        ]
          .filter((l) => l !== null)
          .join("\n") + "\n",
      );
    }
    if (!m.omitPack) {
      writeFileSync(
        join(dir, "pack.toml"),
        m.mode === "autoresearch"
          ? [
              'closing_artifact = "validated-findings record"',
              "",
              "[[phases]]",
              'name = "hypothesize"',
              "",
              "  [[phases.gates]]",
              'name = "gate-one"',
              'kind = "mechanical"',
              'owner = "director"',
              'procedure = "p1"',
              "",
              "[[phases]]",
              'name = "experiment"',
              "",
              "  [[phases.gates]]",
              'name = "gate-two"',
              'kind = "mechanical"',
              'owner = "director"',
              'procedure = "p2"',
              "",
              "[[handoffs]]",
              'kind = "issue_seed"',
              'target = "autodev"',
            ].join("\n") + "\n"
          : [
              'closing_artifact = "landed-delta record"',
              "",
              "[[phases]]",
              'name = "decompose"',
              "",
              "  [[phases.gates]]",
              'name = "dev-gate"',
              'kind = "mechanical"',
              'owner = "director"',
              'procedure = "p1"',
              "",
              "[[phases]]",
              'name = "implement"',
              'roles = ["implementer"]',
              "",
              "  [[phases.gates]]",
              'name = "tdd-red-green"',
              'kind = "mechanical"',
              'owner = "implementer"',
              'procedure = "p2"',
              "",
              "[[handoffs]]",
              'kind = "hypothesis_seed"',
              'target = "autoresearch"',
            ].join("\n") + "\n",
      );
    }
    if (!m.omitCard) {
      writeFileSync(
        join(dir, "card.md"),
        `# ${m.mode} director card\n\n` + (m.omitRegion ? "No rule region here.\n" : generateLedgerDiscoveryRegion()),
      );
    }
  }
  return modesRoot;
}

interface FakeMessage {
  id: string;
  role: "user" | "assistant";
  agent?: string;
}

/** The fake engine client, shaped exactly like the fixture-proven contract:
 *  hey-api {data} envelopes by default, raw payloads with rawShape: true. */
function fakeClient(
  o: {
    agent?: string | null; // the Session.Info.agent session.get returns
    getThrows?: boolean;
    messages?: FakeMessage[] | null; // null → no messages callable at all
    messagesThrow?: boolean;
    rawShape?: boolean;
  } = {},
): {
  client: { session: { get: (o: unknown) => Promise<unknown>; messages?: (o: unknown) => Promise<unknown> } };
  calls: { get: number; messages: number };
} {
  const calls = { get: 0, messages: 0 };
  const wrap = <T>(payload: T): unknown => (o.rawShape ? payload : { data: payload });
  const client = {
    session: {
      get: async (_o: unknown) => {
        calls.get += 1;
        if (o.getThrows) throw new Error("session.get failed (engine unavailable)");
        return wrap({ id: "ses_fixture", agent: o.agent === undefined ? null : o.agent });
      },
      ...(o.messages === null
        ? {}
        : {
            messages: async (_o: unknown) => {
              calls.messages += 1;
              if (o.messagesThrow) throw new Error("session.messages failed");
              return wrap((o.messages ?? []).map((m) => ({ info: m, parts: [] })));
            },
          }),
    },
  };
  return { client, calls };
}

const deps = (registryRoot: string, client: ReturnType<typeof fakeClient>["client"] | null, sessionID = "ses_fixture") => ({
  sessionID,
  engineClient: client,
  registryRoot,
});

describe("H4 — the posture-binding map (D4: a MAP, not a heuristic)", () => {
  it("a director-agent session emits the stamped `## Active mode` block (primary resolution)", async () => {
    const reg = stagedRegistry();
    const { client, calls } = fakeClient({ agent: "autodev" });
    const block = await buildModeBlock(deps(reg, client));
    expect(block).not.toBeNull();
    expect(block!.startsWith("## Active mode")).toBe(true);
    // posture name
    expect(block!).toContain("posture: `autodev`");
    // the phase/gate summary read from the registry bundle
    expect(block!).toContain("decompose");
    expect(block!).toContain("dev-gate");
    expect(block!).toContain("tdd-red-green");
    // the ledger path convention read from the bundle card's generated region
    expect(block!).toContain("sessions/session-<YYYYMMDD>-<slug>.md");
    // the stamp: resolved agent id + registry digest
    expect(block!).toContain("agent=autodev");
    expect(block!).toContain("mode=autodev");
    expect(block!).toContain("resolved=primary");
    expect(/\bregistry-digest=sha256:[0-9a-f]{64}\b/.test(block!)).toBe(true);
    expect(calls.get).toBe(1); // primary path — one session.get, no messages read
    expect(calls.messages).toBe(0);
  });

  it("the block reads the REAL shipped registry bundles correctly (no drift between plugin reader and validator data)", async () => {
    // the real modes/ dir, the way the extension stages it — the block's
    // summary must match the real packs the shared validator enforces.
    const { client } = fakeClient({ agent: "autodev" });
    const block = await buildModeBlock({ sessionID: "ses_x", engineClient: client, registryRoot: join(EXT, "modes") });
    expect(block).not.toBeNull();
    expect(block!).toContain("posture: `autodev`");
    expect(block!).toContain("dev-gate");
    expect(block!).toContain("blocked-by-clearance");
    expect(block!).toContain("tdd-red-green");
    expect(block!).toContain("draft-pr-lifecycle");
    expect(block!).toContain("review");
    // the real card's generated region (the ledger discovery rule) is spliced
    expect(block!).toContain("LEDGER DISCOVERY RULE v1");
    // and the autoresearch bundle binds its own agent
    const { client: c2 } = fakeClient({ agent: "autoresearch" });
    const b2 = await buildModeBlock({ sessionID: "ses_y", engineClient: c2, registryRoot: join(EXT, "modes") });
    expect(b2).toContain("posture: `autoresearch`");
  });

  it.each(["plan", "build", "implementer", "hypothesizer", "reviewer"])(
    "a copilot session (%s — every agent id outside the registry's mode agents) emits NOTHING",
    async (agent) => {
      const reg = stagedRegistry();
      const { client } = fakeClient({ agent });
      const block = await buildModeBlock(deps(reg, client));
      expect(block).toBeNull();
    },
  );

  it("the binding comes from the manifest's declared agent, never from a mode-name match (an agent ≠ mode name does not bind)", async () => {
    const reg = stagedRegistry({ modes: [{ mode: "custommode", agent: "otheragent" }] });
    const { client } = fakeClient({ agent: "custommode" }); // matches the MODE name, not the declared agent
    expect(await buildModeBlock(deps(reg, client))).toBeNull();
    const { client: c2 } = fakeClient({ agent: "otheragent" }); // the declared agent binds
    const block = await buildModeBlock(deps(reg, c2));
    expect(block).not.toBeNull();
    expect(block!).toContain("mode=custommode");
  });

  it("a missing sessionID emits nothing (there is no session to resolve, and no posture to name)", async () => {
    const reg = stagedRegistry();
    expect(await buildModeBlock({ sessionID: null, engineClient: null, registryRoot: reg })).toBeNull();
  });

  it("a machine with NO staged registry (pre-registry build) emits nothing — silent is honest, the doctor owns the staleness verdict", async () => {
    const reg = join(mkdtempSync(join(tmpdir(), "mode-block-noreg-")), "modes"); // never created
    const { client } = fakeClient({ agent: "autodev" });
    expect(await buildModeBlock(deps(reg, client))).toBeNull();
  });

  it("a bundle whose manifest is missing/unparseable is SKIPPED (mid-staging or corrupt — the doctor names it), and its agent does NOT bind by name", async () => {
    const reg = stagedRegistry({
      modes: [
        { mode: "autodev", omitManifest: true },
        { mode: "autoresearch" },
      ],
    });
    // autodev's bundle is unreadable: no binding exists → copilot-silent (the
    // doctor's verdict owns the corruption; the plugin never guesses)
    const { client } = fakeClient({ agent: "autodev" });
    expect(await buildModeBlock(deps(reg, client))).toBeNull();
    // the OTHER bundle still serves its sessions normally
    const { client: c2 } = fakeClient({ agent: "autoresearch" });
    expect((await buildModeBlock(deps(reg, c2)))!).toContain("posture: `autoresearch`");
  });
});

describe("H4 — compaction survival (the block is per-request, from session state alone)", () => {
  it("a simulated compaction (fresh request, history dropped) still emits the block — the primary path never reads the message history", async () => {
    const reg = stagedRegistry();
    // history DROPPED: no messages at all — the block must come from session
    // state alone (session.get), exactly the post-compaction shape.
    const { client, calls } = fakeClient({ agent: "autodev", messages: null });
    const block = await buildModeBlock(deps(reg, client));
    expect(block).not.toBeNull();
    expect(block!).toContain("posture: `autodev`");
    expect(calls.get).toBe(1);
    expect(calls.messages).toBe(0); // the history was never consulted
  });
});

describe("H4 — the unresolvable line (staged bundle, no resolution)", () => {
  it("session.get failing with the fallback also failing emits the explicit unresolvable line", async () => {
    const reg = stagedRegistry();
    const { client } = fakeClient({ getThrows: true, messagesThrow: true });
    const block = await buildModeBlock(deps(reg, client));
    expect(block).not.toBeNull();
    expect(block!.startsWith("## Active mode")).toBe(true);
    expect(block!).toContain(UNRESOLVABLE_LINE);
  });

  it("no engine client at all (legacy load path) + a staged registry → the unresolvable line, never posture-blind silence", async () => {
    const reg = stagedRegistry();
    const block = await buildModeBlock(deps(reg, null));
    expect(block).not.toBeNull();
    expect(block!).toContain(UNRESOLVABLE_LINE);
  });

  it("session.get returning NO agent field (older wire shape) + no message history → unresolvable", async () => {
    const reg = stagedRegistry();
    const { client } = fakeClient({ agent: null, messages: [] });
    const block = await buildModeBlock(deps(reg, client));
    expect(block).not.toBeNull();
    expect(block!).toContain(UNRESOLVABLE_LINE);
  });
});

describe("H4 — honest degradation (resolved director posture, missing bundle parts)", () => {
  it("a missing pack.toml emits the block with a degraded line NAMING it (no phase/gate summary fabricated)", async () => {
    const reg = stagedRegistry({ modes: [{ mode: "autodev", omitPack: true }] });
    const { client } = fakeClient({ agent: "autodev" });
    const block = await buildModeBlock(deps(reg, client));
    expect(block).not.toBeNull();
    expect(block!).toContain("posture: `autodev`");
    expect(block!).toContain("DEGRADED");
    expect(block!).toContain("pack.toml"); // the missing part is NAMED
    expect(block!).not.toContain("dev-gate"); // nothing fabricated
    expect(block!).toContain("LEDGER DISCOVERY RULE v1"); // the readable parts still bind
    expect(block!).toContain("agent=autodev");
  });

  it("a missing card.md names it and omits the ledger rule section", async () => {
    const reg = stagedRegistry({ modes: [{ mode: "autodev", omitCard: true }] });
    const { client } = fakeClient({ agent: "autodev" });
    const block = await buildModeBlock(deps(reg, client));
    expect(block).not.toBeNull();
    expect(block!).toContain("DEGRADED");
    expect(block!).toContain("card.md");
    expect(block!).not.toContain("LEDGER DISCOVERY RULE v1");
  });

  it("a card present but missing its generated region names the region", async () => {
    const reg = stagedRegistry({ modes: [{ mode: "autodev", omitRegion: true }] });
    const { client } = fakeClient({ agent: "autodev" });
    const block = await buildModeBlock(deps(reg, client));
    expect(block).not.toBeNull();
    expect(block!).toContain("DEGRADED");
    expect(block!).toContain("ledger-discovery-rule");
  });
});

describe("H4 — the plugin version gap (the loud failure, never silence)", () => {
  it("a bundle floor above the plugin's supported version emits the unresolvable block with the gap render (byte-parity with checkConsumerFloor)", async () => {
    const reg = stagedRegistry({ modes: [{ mode: "autodev", pluginFloor: "2" }] });
    const { client } = fakeClient({ agent: "autodev" });
    const block = await buildModeBlock(deps(reg, client));
    expect(block).not.toBeNull();
    expect(block!.startsWith("## Active mode")).toBe(true);
    // the exact render the shared validator produces for the plugin consumer —
    // the two vocabularies name one outcome (D1), byte-for-byte
    const gap = checkConsumerFloor({ doctor: "1", plugin: "2", stager: "1", tests: "1" }, "plugin", "1");
    expect(gap.ok).toBe(false);
    if (!gap.ok) expect(block!).toContain(gap.render);
    expect(block!).not.toContain("posture: `autodev`"); // never a guessed posture over an untrustable registry
  });

  it("the version gap is loud even for a session that would otherwise bind copilot — the map itself is untrustable", async () => {
    const reg = stagedRegistry({ modes: [{ mode: "autodev", pluginFloor: "2" }] });
    const { client } = fakeClient({ agent: "plan" });
    const block = await buildModeBlock(deps(reg, client));
    expect(block).not.toBeNull(); // NEVER silence on a version gap
    expect(block!).toContain("version gap");
  });
});

describe("H4 — the last-assistant-message fallback (guarded, decline-correct)", () => {
  it("fires ONLY on resolution failure: a failing session.get falls back to the last assistant message's agent (stamped resolved=fallback)", async () => {
    const reg = stagedRegistry();
    const { client, calls } = fakeClient({
      getThrows: true,
      messages: [
        { id: "msg_001", role: "user", agent: "autoresearch" },
        { id: "msg_002", role: "assistant", agent: "autoresearch" },
        { id: "msg_003", role: "user", agent: "autoresearch" }, // same agent — no switch
      ],
    });
    const block = await buildModeBlock(deps(reg, client));
    expect(block).not.toBeNull();
    expect(block!).toContain("posture: `autoresearch`");
    expect(block!).toContain("resolved=fallback");
    expect(calls.messages).toBe(1);
  });

  it("DECLINES when the agent-switched stream shows a switch newer on the monotonic key — the unresolvable line, never a wrong posture", async () => {
    const reg = stagedRegistry();
    // the last assistant message ran autoresearch; the user then SWITCHED to
    // autodev (a newer user message carries the new agent). The fallback would
    // read msg_002's stale agent — it declines instead.
    const { client } = fakeClient({
      getThrows: true,
      messages: [
        { id: "msg_001", role: "user", agent: "autoresearch" },
        { id: "msg_002", role: "assistant", agent: "autoresearch" },
        { id: "msg_003", role: "user", agent: "autodev" }, // the switch — NEWER on the message id (the monotonic key, same store)
      ],
    });
    const block = await buildModeBlock(deps(reg, client));
    expect(block).not.toBeNull();
    expect(block!).toContain(UNRESOLVABLE_LINE);
    // never a wrong posture: no autoresearch binding is emitted
    expect(block!).not.toContain("posture: `autoresearch`");
    expect(block!).not.toContain("resolved=fallback");
  });

  it("a switch newer via an assistant message (role-cast turn) also declines", async () => {
    const reg = stagedRegistry();
    const { client } = fakeClient({
      getThrows: true,
      messages: [
        { id: "msg_001", role: "assistant", agent: "autodev" },
        { id: "msg_002", role: "user", agent: "implementer" }, // dispatched cast switch, newer key
      ],
    });
    const block = await buildModeBlock(deps(reg, client));
    expect(block).not.toBeNull();
    expect(block!).toContain(UNRESOLVABLE_LINE);
  });

  it("no assistant message to read (fresh session, or history dropped by compaction) → the fallback fails honestly → unresolvable", async () => {
    const reg = stagedRegistry();
    const { client } = fakeClient({ getThrows: true, messages: [] });
    expect((await buildModeBlock(deps(reg, client)))!).toContain(UNRESOLVABLE_LINE);
  });

  it("the fallback reads NO wall-clock and NO prose: messages without agents/timestamps never fabricate a posture", async () => {
    const reg = stagedRegistry();
    const { client } = fakeClient({
      getThrows: true,
      messages: [
        { id: "msg_001", role: "assistant" }, // no agent field at all
        { id: "msg_002", role: "user" },
      ],
    });
    const block = await buildModeBlock(deps(reg, client));
    expect(block).not.toBeNull();
    expect(block!).toContain(UNRESOLVABLE_LINE);
  });

  it("a fallback-resolved COPILOT agent stays silent (the map binds the resolved id, whatever resolved it)", async () => {
    const reg = stagedRegistry();
    const { client } = fakeClient({
      getThrows: true,
      messages: [
        { id: "msg_001", role: "user", agent: "plan" },
        { id: "msg_002", role: "assistant", agent: "plan" },
      ],
    });
    expect(await buildModeBlock(deps(reg, client))).toBeNull();
  });

  it("no messages callable on the client (older engine client) → unresolvable when the primary fails", async () => {
    const reg = stagedRegistry();
    const { client } = fakeClient({ getThrows: true, messages: null });
    const block = await buildModeBlock(deps(reg, client));
    expect(block).not.toBeNull();
    expect(block!).toContain(UNRESOLVABLE_LINE);
  });
});

describe("H4 — parity with the shared validator (the plugin stays dependency-free, the constants stay in step by construction)", () => {
  it("PLUGIN_SUPPORTED_MODE_BUNDLE_VERSION ≡ schema's SUPPORTED_MODE_BUNDLE_VERSION", () => {
    expect(PLUGIN_SUPPORTED_MODE_BUNDLE_VERSION).toBe(SUPPORTED_MODE_BUNDLE_VERSION);
  });

  it("the unresolvable headline is byte-exact the spec's D4 line", () => {
    expect(UNRESOLVABLE_HEADLINE).toBe(UNRESOLVABLE_LINE);
  });

  it("the plugin's version compare ≡ schema's compareModeVersions over a corpus", () => {
    const corpus: Array<[string, string]> = [
      ["1", "1"], ["1", "2"], ["2", "1"], ["1", "10"], ["10", "9"],
      ["1.2", "1.10"], ["v1", "v2"], ["1", "v1"], ["2a", "2b"], ["1.0.1", "1.0.9"],
      ["1", "1.0"], ["99", "100"],
    ];
    for (const [a, b] of corpus) {
      expect(compareModeVersionsPlugin(a, b)).toBe(compareModeVersions(a, b));
    }
  });

  it("the raw-payload client shape (older call shapes) is tolerated — same unwrap idiom as session_spawn.ts", async () => {
    const reg = stagedRegistry();
    const { client } = fakeClient({ agent: "autodev", rawShape: true });
    const block = await buildModeBlock(deps(reg, client));
    expect(block).not.toBeNull();
    expect(block!).toContain("posture: `autodev`");
  });
});

