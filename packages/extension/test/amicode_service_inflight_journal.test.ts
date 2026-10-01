// #1552 (interrupted-session re-dispatch): a hub engine bounce (SIGTERM at
// restart, or a crash) kills every in-flight agent loop — they live in the
// engine process's memory — and nothing re-dispatches them once the engine
// returns. The fix's whole state machine lives in the extension layer:
//   track   — the service's dispatch seam journals every proxied chat POST
//             (start on entry, end on response close — the same seam that
//             sees every engine-bound request),
//   derive  — a PURE function folds the journal into the interrupted set
//             (start-without-end, recent enough, capped),
//   resume  — the runner's boot path, after engine health, fires ONE
//             mechanical resume turn per interrupted session (fire-and-forget
//             — the chat POST holds until the turn completes, tens of
//             minutes; boot must never wedge), then clears the journal.
//
// Groups below, in that order: the pure derivation (the issue's unit-test
// acceptance: interrupted-set from the journal, resume-message shape, the
// cap, the never-wedge failure path), the route match, the append sidecar,
// the dispatch integration (a real proxied chat turn, a client-killed one),
// and the runner's boot-time re-dispatch (the fake-engine idiom of
// amicode_service_runner.test.ts).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as http from "node:http";
import type { ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import { createAmicodeService } from "../src/amicode_service";
import { bootAmicodeServiceRunner, type AmicodeServiceRunnerBoot } from "../src/amicode_service_runner";
import { serverAuthHeader } from "../src/server_auth";
import {
  RESUME_CAP,
  RESUME_MESSAGE,
  RESUME_RECENT_MS_DEFAULT,
  clearInflightJournal,
  deriveInterruptedSessions,
  matchInflightChatTurn,
  readInterruptedSessions,
  trackInflightChatTurn,
} from "../src/amicode_service/inflight_journal";

/** Poll until pred() holds (the fire-and-forget resume POSTs land on the
 *  event loop AFTER the boot promise resolves — assertions must wait for
 *  the evidence, not for the boot). */
async function waitUntil(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not met within timeout");
}

// ── the pure derivation ──────────────────────────────────────────────────────

describe("#1552 in-flight journal — deriveInterruptedSessions (pure)", () => {
  const now = 1_000_000_000_000;
  const line = (kind: "start" | "end", sessionID: string, ts: number): string =>
    JSON.stringify({ kind, sessionID, ts });

  it("a start without a matching end is the interrupted shape; a matched end closes it", () => {
    const interrupted = deriveInterruptedSessions(line("start", "ses-a", now - 5_000) + "\n", now);
    expect(interrupted.map((s) => s.sessionID)).toEqual(["ses-a"]);
    const completed = deriveInterruptedSessions(
      line("start", "ses-a", now - 5_000) + "\n" + line("end", "ses-a", now - 4_000) + "\n",
      now,
    );
    expect(completed).toEqual([]);
  });

  it("a re-start after an end is interrupted again — the LATEST unmatched start is the one that counts", () => {
    const journal =
      line("start", "ses-a", now - 30_000) +
      "\n" +
      line("end", "ses-a", now - 20_000) +
      "\n" +
      line("start", "ses-a", now - 10_000) +
      "\n";
    const out = deriveInterruptedSessions(journal, now);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ sessionID: "ses-a", ts: now - 10_000 });
  });

  it("never-resume shapes: only ends, or starts older than the recency window", () => {
    expect(deriveInterruptedSessions(line("end", "ses-endonly", now - 1) + "\n", now)).toEqual([]);
    const stale = deriveInterruptedSessions(
      line("start", "ses-stale", now - RESUME_RECENT_MS_DEFAULT - 1) + "\n",
      now,
    );
    expect(stale).toEqual([]);
    const fresh = deriveInterruptedSessions(
      line("start", "ses-fresh", now - RESUME_RECENT_MS_DEFAULT + 1) + "\n",
      now,
    );
    expect(fresh.map((s) => s.sessionID)).toEqual(["ses-fresh"]);
  });

  it("the cap is 8 and keeps the MOST RECENT starts (a corrupted journal cannot fan out unbounded work)", () => {
    expect(RESUME_CAP).toBe(8);
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) lines.push(line("start", `ses-${i}`, now - i * 1_000));
    const out = deriveInterruptedSessions(lines.join("\n") + "\n", now);
    expect(out).toHaveLength(8);
    expect(out.map((s) => s.sessionID)).toEqual([
      "ses-0",
      "ses-1",
      "ses-2",
      "ses-3",
      "ses-4",
      "ses-5",
      "ses-6",
      "ses-7",
    ]);
  });

  it("corrupt or foreign lines are skipped, never fatal; an empty journal is a clean boot", () => {
    const journal =
      "not json\n" +
      JSON.stringify({ kind: "weird", sessionID: "ses-x" }) +
      "\n" +
      line("start", "ses-good", now - 1_000) +
      "\n";
    expect(deriveInterruptedSessions(journal, now).map((s) => s.sessionID)).toEqual(["ses-good"]);
    expect(deriveInterruptedSessions("", now)).toEqual([]);
  });

  it("readInterruptedSessions: a missing journal file is a clean boot, not a failure", () => {
    expect(readInterruptedSessions(join(tmpdir(), `amicode-no-such-journal-${Date.now()}.jsonl`), now)).toEqual([]);
  });
});

// ── the route match ──────────────────────────────────────────────────────────

describe("#1552 in-flight journal — the chat-turn route match", () => {
  it("POST /session/{id}/message is the one tracked route — the SDK's session.prompt (v1 {id}, v2 {sessionID}: the same URL)", () => {
    expect(matchInflightChatTurn("POST", "/session/ses_abc123/message")).toBe("ses_abc123");
  });

  it("GETs, SSE, and every other session route stay untracked — they observe, they don't run a loop", () => {
    expect(matchInflightChatTurn("GET", "/session/ses_abc123/message")).toBeUndefined(); // the message LIST
    expect(matchInflightChatTurn("GET", "/session/ses_abc123/message/msg_1")).toBeUndefined(); // one message
    expect(matchInflightChatTurn("POST", "/session")).toBeUndefined(); // session create
    expect(matchInflightChatTurn("POST", "/session/ses_abc123/abort")).toBeUndefined();
    expect(matchInflightChatTurn("POST", "/session/ses_abc123/command")).toBeUndefined();
    expect(matchInflightChatTurn("POST", "/session/ses_abc123/shell")).toBeUndefined();
    expect(matchInflightChatTurn("POST", "/session/ses_abc123/share")).toBeUndefined();
    expect(matchInflightChatTurn("POST", "/session/ses_abc123/summarize")).toBeUndefined();
    expect(matchInflightChatTurn("POST", "/session/ses_abc123/prompt_async")).toBeUndefined();
    expect(matchInflightChatTurn("POST", "/session/ses_abc123")).toBeUndefined(); // session update is PATCH, not this
    expect(matchInflightChatTurn("GET", "/event")).toBeUndefined(); // the SSE observer
    expect(matchInflightChatTurn("GET", "/session")).toBeUndefined();
  });
});

// ── the append sidecar ───────────────────────────────────────────────────────

describe("#1552 in-flight journal — append + clear (trackInflightChatTurn)", () => {
  /** A stand-in response: the only surface the hook touches is "once close". */
  const fakeRes = (): ServerResponse => new EventEmitter() as unknown as ServerResponse;

  it("writes a start line on track, and the response's close writes the matching end", () => {
    const dir = mkdtempSync(join(tmpdir(), "amicode-inflight-unit-"));
    const journal = join(dir, "active-sessions.jsonl");
    const res = fakeRes();
    trackInflightChatTurn(res, "ses-track", journal);
    const start = JSON.parse(readFileSync(journal, "utf8")) as { kind: string; sessionID: string };
    expect(start).toMatchObject({ kind: "start", sessionID: "ses-track" });
    res.emit("close");
    const lines = readFileSync(journal, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { kind: string; sessionID: string });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ kind: "end", sessionID: "ses-track" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("the parent directory is created on demand (~/.amico/server does not pre-exist on a fresh hub)", () => {
    const dir = mkdtempSync(join(tmpdir(), "amicode-inflight-mkdir-"));
    const journal = join(dir, "nested", "deeper", "active-sessions.jsonl");
    expect(() => trackInflightChatTurn(fakeRes(), "ses-mkdir", journal)).not.toThrow();
    expect(existsSync(journal)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends are best-effort: an unwritable journal never throws into the request path", () => {
    const dir = mkdtempSync(join(tmpdir(), "amicode-inflight-unwritable-"));
    const fileAsParent = join(dir, "a-regular-file");
    writeFileSync(fileAsParent, "not a directory");
    const journal = join(fileAsParent, "active-sessions.jsonl"); // ENOTDIR under any mkdir/append
    const res = fakeRes();
    expect(() => trackInflightChatTurn(res, "ses-bad", journal)).not.toThrow();
    expect(() => res.emit("close")).not.toThrow(); // the close-path append is equally best-effort
    rmSync(dir, { recursive: true, force: true });
  });

  it("clearInflightJournal empties the file so the next boot derives nothing (no double-resume)", () => {
    const dir = mkdtempSync(join(tmpdir(), "amicode-inflight-clear-"));
    const journal = join(dir, "active-sessions.jsonl");
    trackInflightChatTurn(fakeRes(), "ses-clear", journal);
    clearInflightJournal(journal);
    expect(readFileSync(journal, "utf8")).toBe("");
    expect(readInterruptedSessions(journal)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("the resume nudge's exact text (the issue's wording — mechanical, no new instructions)", () => {
    expect(RESUME_MESSAGE).toBe(
      "[auto-resume] The engine restarted while your loop was in flight (issue #1552). Re-read your session ledger/state and continue exactly where you left off.",
    );
  });
});

// ── the dispatch seam (a real proxied chat turn through the service) ────────

describe("#1552 in-flight journal — the dispatch seam (proxied chat turns are journaled)", () => {
  let root: string;
  let journal: string;
  let engineUrl: string;
  let engineSockets: Set<http.IncomingMessage["socket"]>;
  let engineServer: http.Server;
  let service: ReturnType<typeof createAmicodeService>;
  let base: string;
  const enginePassword = "inflight-engine-mint";
  let engineAuth: string;
  let prevEnv: string | undefined;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "amicode-inflight-dispatch-"));
    journal = join(root, "active-sessions.jsonl");
    // The journal path is env-carried (the production config surface —
    // AMICODE_INFLIGHT_JOURNAL); pin it for hermetic assertions.
    prevEnv = process.env.AMICODE_INFLIGHT_JOURNAL;
    process.env.AMICODE_INFLIGHT_JOURNAL = journal;

    // The mock engine: everything answers 200 JSON; the HOLD route never
    // answers — an in-flight turn. Sockets are tracked so afterAll can
    // destroy held connections (server.close() waits for them otherwise).
    engineSockets = new Set();
    engineServer = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/session/ses-hold/message") return; // never answered
      let body = "";
      req.on("data", (c: Buffer) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, mockEngine: true, echo: body }));
      });
    });
    engineServer.on("connection", (s) => {
      engineSockets.add(s);
      s.on("close", () => engineSockets.delete(s));
    });
    await new Promise<void>((r) => engineServer.listen(0, "127.0.0.1", r));
    engineUrl = `http://127.0.0.1:${(engineServer.address() as AddressInfo).port}`;

    service = createAmicodeService({
      password: "service-own-mint",
      engine: { password: enginePassword, getUrl: () => engineUrl },
    });
    base = (await service.start()).toString().replace(/\/$/, "");
    engineAuth = serverAuthHeader(enginePassword);
  });

  afterAll(async () => {
    await service.stop();
    for (const s of engineSockets) s.destroy();
    await new Promise<void>((r) => engineServer.close(() => r()));
    if (prevEnv === undefined) delete process.env.AMICODE_INFLIGHT_JOURNAL;
    else process.env.AMICODE_INFLIGHT_JOURNAL = prevEnv;
    rmSync(root, { recursive: true, force: true });
  });

  const journalLines = (): string[] =>
    readFileSync(journal, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");

  it("a proxied chat POST journals start + end; the same-route GET and the session list journal nothing", async () => {
    const r = await fetch(`${base}/session/ses-ok/message`, {
      method: "POST",
      headers: { Authorization: engineAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "run" }] }),
    });
    expect(r.status).toBe(200);
    const lines = journalLines().map((l) => JSON.parse(l) as { kind: string; sessionID: string });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ kind: "start", sessionID: "ses-ok" });
    expect(lines[1]).toMatchObject({ kind: "end", sessionID: "ses-ok" });
    // The turn completed — this session is NOT interrupted.
    expect(readInterruptedSessions(journal).map((s) => s.sessionID)).toEqual([]);
    // Observers ride the same origin without being tracked: the message
    // LIST (GET of the same path) and the session list.
    await fetch(`${base}/session/ses-ok/message`, { headers: { Authorization: engineAuth } });
    await fetch(`${base}/session`, { headers: { Authorization: engineAuth } });
    expect(journalLines()).toHaveLength(2);
  });

  it("an interrupted proxied chat POST (client death) leaves start-without-end = INTERRUPTED — the bounce shape", async () => {
    const controller = new AbortController();
    const pendingTurn = fetch(`${base}/session/ses-hold/message`, {
      method: "POST",
      headers: { Authorization: engineAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "a long research loop" }] }),
      signal: controller.signal,
    }).catch(() => undefined); // the client abort is the expected outcome — caught HERE, at creation
    void pendingTurn;
    // The start line lands the instant the request enters dispatch.
    await waitUntil(() => journalLines().some((l) => l.includes("ses-hold")));
    expect(readInterruptedSessions(journal).map((s) => s.sessionID)).toEqual(["ses-hold"]);
    // The client dies (lid-close, tunnel death — or the SIGTERM that takes
    // the service down with it): the response closes, the end line lands.
    controller.abort();
    await waitUntil(() => journalLines().some((l) => l.includes('"end"') && l.includes("ses-hold")));
    expect(readInterruptedSessions(journal)).toEqual([]);
    await pendingTurn;
  });
});

// ── the runner's boot-time re-dispatch (the fake-engine idiom) ───────────────

describe("#1552 runner — interrupted-session re-dispatch on boot", () => {
  const boots: AmicodeServiceRunnerBoot[] = [];
  afterAll(async () => {
    for (const b of boots.splice(0)) await b.shutdown().catch(() => undefined);
  });

  /** A stand-in engine binary (the shebang-node fake-engine idiom): answers
   *  the health GET with 200; records every non-GET request (the resume
   *  POSTs) to the dump as JSONL {method, url, auth, body}; FAKE_ENGINE_FAIL
   *  answers 500 to them, FAKE_ENGINE_HOLD never answers (the in-flight
   *  shape), else 200 with the SDK's SessionPromptResponses shape. */
  function writeResumeEngine(dir: string): { bin: string; dump: string } {
    const bin = join(dir, "fake-engine");
    const dump = join(dir, "resume-dump.jsonl");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const { createServer } = require("node:http");
const { appendFileSync } = require("node:fs");
const port = Number(process.argv[4] ?? 0);
const dump = ${JSON.stringify(dump)};
createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("fake engine up");
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    appendFileSync(dump, JSON.stringify({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, body }) + "\\n");
    if (process.env.FAKE_ENGINE_FAIL) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false }));
      return;
    }
    if (process.env.FAKE_ENGINE_HOLD) return; // never answer: the turn stays in flight
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ info: { id: "msg_resume", role: "assistant" }, parts: [] }));
  });
}).listen(port, "127.0.0.1");
`,
    );
    chmodSync(bin, 0o755);
    return { bin, dump };
  }

  function writeStubShelf(dir: string): string {
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>stub shelf</title>");
    return dir;
  }

  function writeJournal(lines: Array<{ kind: "start" | "end"; sessionID: string; ts: number }>): string {
    const journal = join(mkdtempSync(join(tmpdir(), "amicode-resume-journal-")), "active-sessions.jsonl");
    writeFileSync(journal, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return journal;
  }

  interface ResumeHit {
    method: string;
    url: string;
    auth: string | null;
    body: string;
  }
  const dumpHits = (dump: string): ResumeHit[] =>
    existsSync(dump)
      ? readFileSync(dump, "utf8")
          .split("\n")
          .filter((l) => l.trim() !== "")
          .map((l) => JSON.parse(l) as ResumeHit)
      : [];

  it("the interrupted set gets ONE resume POST per session with the exact nudge text, then the journal is cleared", async () => {
    const dir = mkdtempSync(join(tmpdir(), "amicode-resume-dispatch-"));
    const { bin, dump } = writeResumeEngine(dir);
    const now = Date.now();
    const journal = writeJournal([
      { kind: "start", sessionID: "ses-one", ts: now - 60_000 },
      { kind: "start", sessionID: "ses-two", ts: now - 30_000 },
      { kind: "start", sessionID: "ses-done", ts: now - 120_000 },
      { kind: "end", sessionID: "ses-done", ts: now - 110_000 },
      { kind: "start", sessionID: "ses-stale", ts: now - RESUME_RECENT_MS_DEFAULT - 60_000 },
    ]);
    const lines: string[] = [];
    const boot = await bootAmicodeServiceRunner({
      engineBin: bin,
      appDistRoot: writeStubShelf(mkdtempSync(join(tmpdir(), "amicode-resume-shelf-"))),
      enginePassword: "resume-engine-mint",
      resumeJournalPath: journal,
      healthTimeoutMs: 10_000,
      servicePort: 0,
      enginePort: 0,
      log: (l) => lines.push(l),
    });
    boots.push(boot);

    // Exactly one POST per interrupted session (fire-and-forget lands
    // after the boot resolves — wait for the evidence).
    await waitUntil(() => dumpHits(dump).length >= 2);
    const hits = dumpHits(dump);
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.url).sort()).toEqual(["/session/ses-one/message", "/session/ses-two/message"]);
    for (const hit of hits) {
      expect(hit.method).toBe("POST");
      // The POST carries the ENGINE credential (serverAuthHeader(enginePassword)).
      expect(hit.auth).toBe(serverAuthHeader("resume-engine-mint"));
      // The same body schema the SDK uses for a user prompt, carrying the exact nudge.
      const body = JSON.parse(hit.body) as { parts?: Array<{ type?: string; text?: string }> };
      expect(body.parts).toEqual([{ type: "text", text: RESUME_MESSAGE }]);
    }
    // Third parties untouched: the matched-end session and the stale one never resume.
    expect(hits.some((h) => h.url.includes("ses-done"))).toBe(false);
    expect(hits.some((h) => h.url.includes("ses-stale"))).toBe(false);
    // The journal is cleared — a subsequent boot cannot double-resume.
    expect(readFileSync(journal, "utf8")).toBe("");
    // Every resume outcome = one log line.
    await waitUntil(() => lines.filter((l) => l.includes("resume turn for session")).length >= 2);
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it("fire-and-forget: a chat POST that never answers (the tens-of-minutes turn) never wedges the boot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "amicode-resume-hold-"));
    const { bin, dump } = writeResumeEngine(dir);
    const journal = writeJournal([{ kind: "start", sessionID: "ses-held", ts: Date.now() - 1_000 }]);
    // The boot RESOLVES (the await below returns) while the resume turn is
    // still in flight — that is the never-wedge contract.
    const boot = await bootAmicodeServiceRunner({
      engineBin: bin,
      appDistRoot: writeStubShelf(mkdtempSync(join(tmpdir(), "amicode-resume-hold-shelf-"))),
      engineEnv: { FAKE_ENGINE_HOLD: "1" },
      resumeJournalPath: journal,
      healthTimeoutMs: 10_000,
      servicePort: 0,
      enginePort: 0,
      log: () => undefined,
    });
    boots.push(boot);
    await waitUntil(() => dumpHits(dump).length >= 1);
    expect(dumpHits(dump)[0].url).toBe("/session/ses-held/message");
    expect(readFileSync(journal, "utf8")).toBe("");
    // Teardown destroys the held connection — the dangling fetch rejects
    // into its own catch, never the process.
    await boot.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it("a FAILED resume turn is one log line and never a failed boot (the service still serves)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "amicode-resume-reject-"));
    const { bin } = writeResumeEngine(dir);
    const journal = writeJournal([{ kind: "start", sessionID: "ses-rej", ts: Date.now() - 1_000 }]);
    const lines: string[] = [];
    const boot = await bootAmicodeServiceRunner({
      engineBin: bin,
      appDistRoot: writeStubShelf(mkdtempSync(join(tmpdir(), "amicode-resume-reject-shelf-"))),
      resumeJournalPath: journal,
      // Injected for tests: the POST itself rejects (engine unreachable mid-fire).
      resumeFetch: () => Promise.reject(new Error("engine refused the resume turn")),
      healthTimeoutMs: 10_000,
      servicePort: 0,
      enginePort: 0,
      log: (l) => lines.push(l),
    });
    boots.push(boot);
    await waitUntil(() =>
      lines.some((l) => l.includes("resume turn for session ses-rej failed: engine refused the resume turn")),
    );
    // The boot is up and serving — a resume failure never wedges or fails it.
    const doc = await fetch(`${boot.url}/`, { headers: { Authorization: boot.authHeader } });
    expect(doc.status).toBe(200);
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it("a non-2xx engine answer is logged as the outcome, still never a failed boot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "amicode-resume-500-"));
    const { bin } = writeResumeEngine(dir);
    const journal = writeJournal([{ kind: "start", sessionID: "ses-500", ts: Date.now() - 1_000 }]);
    const lines: string[] = [];
    const boot = await bootAmicodeServiceRunner({
      engineBin: bin,
      appDistRoot: writeStubShelf(mkdtempSync(join(tmpdir(), "amicode-resume-500-shelf-"))),
      engineEnv: { FAKE_ENGINE_FAIL: "1" },
      resumeJournalPath: journal,
      healthTimeoutMs: 10_000,
      servicePort: 0,
      enginePort: 0,
      log: (l) => lines.push(l),
    });
    boots.push(boot);
    await waitUntil(() => lines.some((l) => l.includes("resume turn for session ses-500") && l.includes("500")));
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it("AMICODE_RESUME_DISABLED=1 (resumeDisabled) skips the step — no POST, journal left intact for the operator", async () => {
    const dir = mkdtempSync(join(tmpdir(), "amicode-resume-disabled-"));
    const { bin, dump } = writeResumeEngine(dir);
    const journal = writeJournal([{ kind: "start", sessionID: "ses-skip", ts: Date.now() - 1_000 }]);
    const lines: string[] = [];
    const boot = await bootAmicodeServiceRunner({
      engineBin: bin,
      appDistRoot: writeStubShelf(mkdtempSync(join(tmpdir(), "amicode-resume-disabled-shelf-"))),
      resumeJournalPath: journal,
      resumeDisabled: true,
      healthTimeoutMs: 10_000,
      servicePort: 0,
      enginePort: 0,
      log: (l) => lines.push(l),
    });
    boots.push(boot);
    await new Promise((r) => setTimeout(r, 300)); // any (wrongly) fired POST has time to land
    expect(dumpHits(dump)).toEqual([]);
    expect(readFileSync(journal, "utf8")).not.toBe(""); // untouched — the escape hatch leaves the state alone
    expect(lines.some((l) => l.includes("resume disabled"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it("the unarmed hub posture sends the resume turn ANONYMOUSLY (no credential exists to carry)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "amicode-resume-unarmed-"));
    const { bin, dump } = writeResumeEngine(dir);
    const journal = writeJournal([{ kind: "start", sessionID: "ses-anon", ts: Date.now() - 1_000 }]);
    const boot = await bootAmicodeServiceRunner({
      engineBin: bin,
      appDistRoot: writeStubShelf(mkdtempSync(join(tmpdir(), "amicode-resume-unarmed-shelf-"))),
      engineUnarmed: true,
      resumeJournalPath: journal,
      healthTimeoutMs: 10_000,
      servicePort: 0,
      enginePort: 0,
      log: () => undefined,
    });
    boots.push(boot);
    await waitUntil(() => dumpHits(dump).length >= 1);
    expect(dumpHits(dump)[0].auth).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});
