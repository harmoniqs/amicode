import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordSpan, spanFromMessageEvent, scrubValue, makeTraceHooks, type Span } from "../opencode-plugin/traces";

const span = (over: Partial<Span> = {}): Span => ({
  v: 1,
  ts: "2026-07-09T00:00:00.000Z",
  session: "ses_x",
  span: "tool",
  id: "call_1",
  name: "amicode_solve",
  dur_ms: 42,
  attrs: {},
  error: null,
  ...over,
});

const readLines = (dir: string, ses: string) =>
  readFileSync(join(dir, `${ses}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

describe("recordSpan", () => {
  it("appends one JSON line per span, per-session file", () => {
    const dir = mkdtempSync(join(tmpdir(), "traces-"));
    recordSpan(span(), dir);
    recordSpan(span({ id: "call_2", session: "ses_y" }), dir);
    expect(readLines(dir, "ses_x")).toHaveLength(1);
    expect(readLines(dir, "ses_y")[0].id).toBe("call_2");
  });
  it("AMICODE_TRACES=0 disables recording", () => {
    const dir = mkdtempSync(join(tmpdir(), "traces-"));
    process.env.AMICODE_TRACES = "0";
    try {
      recordSpan(span(), dir);
    } finally {
      delete process.env.AMICODE_TRACES;
    }
    expect(existsSync(join(dir, "ses_x.jsonl"))).toBe(false);
  });
});

describe("scrubValue", () => {
  it("omits credential-looking strings and truncates huge ones", () => {
    expect(scrubValue("Bearer abc123")).toBe("«credential omitted»");
    const big = scrubValue("x".repeat(5000)) as string;
    expect(big.length).toBeLessThan(2100);
    expect(big).toContain("[truncated 5000]");
  });
});

describe("spanFromMessageEvent", () => {
  const evt = (info: Record<string, unknown>) => ({ type: "message.updated", properties: { info } });
  it("completed assistant message → model span with tokens/cache/duration, once", () => {
    const seen = new Set<string>();
    const info = {
      id: "msg_1",
      sessionID: "ses_x",
      role: "assistant",
      providerID: "google",
      modelID: "gemini-2.5-flash",
      time: { created: 1000, completed: 5200 },
      tokens: { input: 25054, output: 168, cache: { read: 0, write: 0 } },
    };
    const s = spanFromMessageEvent(evt(info), seen)!;
    expect(s).toMatchObject({ span: "model", name: "google/gemini-2.5-flash", dur_ms: 4200, session: "ses_x" });
    expect((s.attrs.tokens as { input: number }).input).toBe(25054);
    expect(spanFromMessageEvent(evt(info), seen)).toBeUndefined(); // dedupe
  });
  it("ignores user messages, incomplete messages, other event types", () => {
    const seen = new Set<string>();
    expect(spanFromMessageEvent(evt({ id: "m", role: "user", time: { completed: 1 } }), seen)).toBeUndefined();
    expect(spanFromMessageEvent(evt({ id: "m", role: "assistant", time: {} }), seen)).toBeUndefined();
    expect(spanFromMessageEvent({ type: "session.updated" }, seen)).toBeUndefined();
  });
  it("carries the error (scrubbed) — the silent-failure detector", () => {
    const seen = new Set<string>();
    const s = spanFromMessageEvent(
      evt({
        id: "m2",
        sessionID: "s",
        role: "assistant",
        time: { created: 0, completed: 1 },
        error: { name: "APIError", data: { message: "tools[0] rejected" } },
      }),
      seen,
    )!;
    expect(s.error).toContain("APIError");
  });
});

describe("makeTraceHooks tool pairing", () => {
  it("before/after yields a tool span with a real duration and bounded attrs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "traces-"));
    const hooks = makeTraceHooks(dir);
    await hooks["tool.execute.before"]({ tool: "amicode_solve", sessionID: "ses_t", callID: "c1" }, {});
    await hooks["tool.execute.after"](
      { tool: "amicode_solve", sessionID: "ses_t", callID: "c1", args: { note: "Bearer xyz" } },
      { title: "Run", output: "y".repeat(9000) },
    );
    const [line] = readLines(dir, "ses_t");
    expect(line.span).toBe("tool");
    expect(line.name).toBe("amicode_solve");
    expect(line.dur_ms).toBeGreaterThanOrEqual(0);
    expect(line.attrs.args.note).toBe("«credential omitted»");
    expect(line.attrs.output_chars).toBe(9000);
  });
});
