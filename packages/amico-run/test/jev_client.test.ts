// jev_client — issue #1311 (slice of #1301 session curation): the ONE thin
// Jev client (TypeSafe System One decision model) for amicode's curation
// seams. The contract of record is the live-verified wire shape (2026-09-20,
// harmoniqs/amicode#1311): POST https://api.typesafe.ai/v1/systemone,
// Bearer key, {"model":"jev-latest","state":…,"questions":{…}}; answers
// {"<id>": {"type":"choice","choice":…,"confidence":…,"probabilities":…} |
// {"type":"noul","noul":…}} plus {"model":"jev-x.y.z","usage":{…}}.
//
// Hermetic by construction: the transport is INJECTABLE (tests stub it — no
// network), the key path rides $AMICO_TYPESAFE_KEY_FILE (tests point it at
// temp files — the real key at ~/.amico/typesafe/key is never read here),
// and the receipts journal is injectable (tests write to temp dirs).
// Run: `pnpm --filter @amicode/amico-run test`.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { askJev, jevKeyFile, type JevTransport } from "../src/jev_client.js";

/** The receipt lines a run has appended to its journal. */
function receiptLines(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const NOUL_QUESTION = {
  type: "noul" as const,
  instructions: "Does this session still have an open thread?",
  criteria: { true: "the session awaits a decision or an unfinished step", false: "the session is wrapped up" },
};

/** A hermetic world: temp key file (never the live ~/.amico/typesafe/key) +
 * temp receipts journal. */
function makeWorld() {
  const root = mkdtempSync(join(tmpdir(), "amico-jev-"));
  const key = join(root, "key");
  writeFileSync(key, "k_test_deadbeef00", { mode: 0o600 });
  const receipts = join(root, "receipts", "receipts.jsonl");
  return { root, key, receipts };
}

const CHOICE_QUESTION = {
  type: "choice" as const,
  instructions: "Classify this chat session into exactly one bucket.",
  criteria: {
    "junk-greeting": "greeting-titled, minimal user text",
    substantive: "real work",
    unclassified: "none of the above fits",
  },
};

describe("jev client — the confirmed wire contract (stub transport, no network)", () => {
  let w: ReturnType<typeof makeWorld>;
  beforeEach(() => {
    w = makeWorld();
  });
  afterEach(() => rmSync(w.root, { recursive: true, force: true }));

  it("round-trips a choice question: bearer key from the secrets path, model jev-latest, answers parsed", async () => {
    const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const transport: JevTransport = async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return {
        status: 200,
        text: async () =>
          JSON.stringify({
            model: "jev-1.13.0",
            answers: { junk_bucket: { type: "choice", choice: "junk-greeting", confidence: 0.96, probabilities: { "junk-greeting": 0.96, substantive: 0.04 } } },
            usage: { input_tokens: 500, output_tokens: 21 },
          }),
      };
    };

    const res = await askJev({ junk_bucket: CHOICE_QUESTION }, { title: "hello", user_text_chars: 12 }, {
      sessionId: "ses_1",
      deps: { env: { AMICO_TYPESAFE_KEY_FILE: w.key }, transport, receiptsPath: w.receipts },
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.model).toBe("jev-1.13.0");
    expect(res.answers.junk_bucket).toEqual({ type: "choice", choice: "junk-greeting", confidence: 0.96, probabilities: { "junk-greeting": 0.96, substantive: 0.04 } });
    expect(res.usage).toEqual({ input_tokens: 500, output_tokens: 21 });

    // the REQUEST is the confirmed shape: endpoint, bearer, model, state, questions
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(calls[0].headers.Authorization).toBe("Bearer k_test_deadbeef00");
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
    expect(calls[0].body).toEqual({
      model: "jev-latest",
      state: { title: "hello", user_text_chars: 12 },
      questions: { junk_bucket: CHOICE_QUESTION },
    });
  });

  it("resolves the key path $AMICO_TYPESAFE_KEY_FILE → ~/.amico/typesafe/key (the secrets posture)", () => {
    expect(jevKeyFile({ AMICO_TYPESAFE_KEY_FILE: "/custom/key" })).toBe("/custom/key");
    expect(jevKeyFile({})).toBe(join(process.env.HOME ?? "", ".amico", "typesafe", "key"));
  });
});

// ── AC 1: every call logged as ONE JSON decision record (the S2 receipt pattern) ──
describe("jev client — decision-record receipts", () => {
  let w: ReturnType<typeof makeWorld>;
  beforeEach(() => {
    w = makeWorld();
  });
  afterEach(() => rmSync(w.root, { recursive: true, force: true }));

  const env = () => ({ AMICO_TYPESAFE_KEY_FILE: w.key, AMICO_TYPESAFE_RECEIPTS: w.receipts });

  it("a successful choice call appends exactly one line: primitive, verdict, confidence, latency, model, state size, ts", async () => {
    const transport: JevTransport = async () => ({
      status: 200,
      text: async () =>
        JSON.stringify({
          model: "jev-1.13.0",
          answers: { junk_bucket: { type: "choice", choice: "junk-greeting", confidence: 0.96 } },
          usage: { input_tokens: 500, output_tokens: 21 },
        }),
    });

    const res = await askJev({ junk_bucket: CHOICE_QUESTION }, { title: "hello" }, { sessionId: "ses_r", deps: { env: env(), transport, now: () => 1_000 } });
    expect(res.ok).toBe(true);

    const lines = receiptLines(w.receipts);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      receipt_version: 1,
      kind: "jev-decision",
      session_id: "ses_r",
      primitive: "choice",
      state_bytes: JSON.stringify({ title: "hello" }).length,
      model: "jev-1.13.0",
      usage: { input_tokens: 500, output_tokens: 21 },
    });
    expect(lines[0].verdicts).toEqual([{ id: "junk_bucket", choice: "junk-greeting", confidence: 0.96 }]);
    expect(lines[0].confidence).toBe(0.96);
    expect(typeof lines[0].latency_ms).toBe("number");
    expect(typeof lines[0].ts).toBe("string");
    // the key NEVER lands in the receipt
    expect(JSON.stringify(lines[0])).not.toContain("k_test_");
  });

  it("a noul call receipts the primitive and the noul verdict; a choice confidence is absent", async () => {
    const transport: JevTransport = async () => ({
      status: 200,
      text: async () => JSON.stringify({ model: "jev-1.13.0", answers: { thread: { type: "noul", noul: 0.71 } }, usage: { input_tokens: 300, output_tokens: 9 } }),
    });

    const res = await askJev({ thread: NOUL_QUESTION }, { title: "bug report" }, { sessionId: "ses_n", deps: { env: env(), transport } });
    expect(res.ok).toBe(true);

    const lines = receiptLines(w.receipts);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ primitive: "noul", session_id: "ses_n" });
    expect(lines[0].verdicts).toEqual([{ id: "thread", noul: 0.71 }]);
    expect(lines[0]).not.toHaveProperty("confidence");
  });

  it("a FAILED call still receipts (no silent Jev branch) — error recorded, verdicts absent", async () => {
    const transport: JevTransport = async () => ({ status: 503, text: async () => "unavailable" });

    const res = await askJev({ junk_bucket: CHOICE_QUESTION }, { title: "hello" }, { deps: { env: env(), transport } });
    expect(res.ok).toBe(false);

    const lines = receiptLines(w.receipts);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "jev-decision", primitive: "choice", model: null, error: expect.stringContaining("503") });
    expect(lines[0]).not.toHaveProperty("verdicts");
  });

  it("no key → NO call, NO receipt (unavailability is the fail-open path, not a decision)", async () => {
    const calls: number[] = [];
    const transport: JevTransport = async () => {
      calls.push(1);
      return { status: 200, text: async () => "{}" };
    };

    const res = await askJev({ junk_bucket: CHOICE_QUESTION }, {}, { deps: { env: { AMICO_TYPESAFE_KEY_FILE: join(w.root, "missing-key"), AMICO_TYPESAFE_RECEIPTS: w.receipts }, transport } });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("key-missing");
    expect(calls).toHaveLength(0);
    expect(existsSync(w.receipts)).toBe(false);
  });

  it("the off-switch (AMICO_JEV_DISABLED) disables the path BEFORE the key read — zero calls, zero receipts", async () => {
    const calls: number[] = [];
    const transport: JevTransport = async () => {
      calls.push(1);
      return { status: 200, text: async () => "{}" };
    };

    const res = await askJev({ junk_bucket: CHOICE_QUESTION }, {}, { deps: { env: { AMICO_JEV_DISABLED: "1", AMICO_TYPESAFE_KEY_FILE: w.key, AMICO_TYPESAFE_RECEIPTS: w.receipts }, transport } });

    expect(res).toMatchObject({ ok: false, reason: "disabled" });
    expect(calls).toHaveLength(0);
    expect(existsSync(w.receipts)).toBe(false);
  });

  it("a transport crash and a malformed body are {ok:false} (fail-open), each with its receipt", async () => {
    const crash: JevTransport = async () => {
      throw new Error("socket hang up");
    };
    expect(await askJev({ thread: NOUL_QUESTION }, {}, { deps: { env: env(), transport: crash } })).toMatchObject({ ok: false, reason: "transport" });

    const garbage: JevTransport = async () => ({ status: 200, text: async () => "not json" });
    expect(await askJev({ thread: NOUL_QUESTION }, {}, { deps: { env: env(), transport: garbage } })).toMatchObject({ ok: false, reason: "malformed" });

    const lines = receiptLines(w.receipts);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.error !== undefined)).toBe(true);
    // the key never leaks into error strings either
    expect(JSON.stringify(lines)).not.toContain("k_test_");
  });
});
