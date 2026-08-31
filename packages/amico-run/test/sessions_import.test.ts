import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseClaudeFile } from "../src/sessions_import/parse_claude.js";
import { parseCodexFile } from "../src/sessions_import/parse_codex.js";

function withTempFile(name: string, content: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "amico-sessions-test-"));
  try {
    const p = join(dir, name);
    writeFileSync(p, content);
    fn(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CLAUDE_LINES = [
  JSON.stringify({ type: "user", uuid: "u1", sessionId: "sess-1", timestamp: "2026-08-01T00:00:00Z", message: { role: "user", content: "hello" } }),
  JSON.stringify({
    type: "assistant",
    uuid: "a1",
    parentUuid: "u1",
    timestamp: "2026-08-01T00:00:01Z",
    message: {
      role: "assistant",
      model: "claude-sonnet-5",
      content: [
        { type: "text", text: "hi there" },
        { type: "tool_use", id: "call_1", name: "Bash", input: { cmd: "ls" } },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    uuid: "u2",
    parentUuid: "a1",
    timestamp: "2026-08-01T00:00:02Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "file1" }] },
  }),
].join("\n");

const CODEX_LINES = [
  JSON.stringify({ timestamp: "2026-08-01T00:00:00Z", type: "session_meta", payload: { session_id: "codex-sess-1", cwd: "/tmp", cli_version: "0.1", model_provider: "openai" } }),
  JSON.stringify({ timestamp: "2026-08-01T00:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } }),
  JSON.stringify({ timestamp: "2026-08-01T00:00:02Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] } }),
  JSON.stringify({ timestamp: "2026-08-01T00:00:03Z", type: "response_item", payload: { type: "custom_tool_call", call_id: "call_1", name: "Bash", input: { cmd: "ls" } } }),
  JSON.stringify({ timestamp: "2026-08-01T00:00:04Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_1", output: "file1" } }),
].join("\n");

describe("sessions_import parsers emit opencode-schema-compliant ExportData", () => {
  it("claude: branded IDs, assistant required fields, tool state pairing", () => {
    withTempFile("sess-1.jsonl", CLAUDE_LINES, (p) => {
      const data = parseClaudeFile(p, "/tmp")!;
      expect(data).not.toBeNull();
      expect(data.info.id).toMatch(/^ses_/);
      expect(data.info.title).toBe("hello");

      const ids = new Set(data.messages.map((m) => m.info.id));
      for (const m of data.messages) {
        expect(m.info.id).toMatch(/^msg_/);
        expect(m.info.sessionID).toBe(data.info.id);
        for (const part of m.parts) {
          expect(part.id).toMatch(/^prt_/);
          expect(part.sessionID).toBe(data.info.id);
        }
      }
      expect(ids.size).toBe(data.messages.length);

      const assistant = data.messages.find((m) => m.info.role === "assistant")!;
      expect(assistant.info.parentID).toMatch(/^msg_/);
      expect(assistant.info.modelID).toBe("claude-sonnet-5");
      expect(assistant.info.providerID).toBe("anthropic");
      expect(assistant.info.mode).toBe("import");
      expect(assistant.info.cost).toBe(0);
      expect(assistant.info.tokens).toBeDefined();

      const toolPart = data.messages.flatMap((m) => m.parts).find((p) => p.type === "tool") as
        | { type: "tool"; state: { status: string; output?: string } }
        | undefined;
      expect(toolPart).toBeDefined();
      expect(toolPart!.state.status).toBe("completed");
      expect(toolPart!.state.output).toBe("file1");
    });
  });

  it("codex: filename UUID wins over shared session_id, tool state completed", () => {
    withTempFile("rollout-2026-08-01T00-00-00-01a015ee-4e7d-70d3-a70b-b9515eb7149e.jsonl", CODEX_LINES, (p) => {
      const data = parseCodexFile(p, "/tmp")!;
      expect(data).not.toBeNull();
      expect(data.info.id).toBe("ses_01a015ee-4e7d-70d3-a70b-b9515eb7149e");
      expect((data.info.metadata as Record<string, unknown>).codex_session_id).toBe("codex-sess-1");

      for (const m of data.messages) {
        expect(m.info.id).toMatch(/^msg_/);
        expect(m.info.sessionID).toBe(data.info.id);
      }
      const toolPart = data.messages.flatMap((m) => m.parts).find((p) => p.type === "tool") as
        | { type: "tool"; state: { status: string; output?: string } }
        | undefined;
      expect(toolPart).toBeDefined();
      expect(toolPart!.state.status).toBe("completed");
      expect(toolPart!.state.output).toBe("file1");
    });
  });

  it("claude: two files sharing a sessionId do NOT collide (filename wins)", () => {
    let id1 = "";
    let id2 = "";
    withTempFile("sess-1.jsonl", CLAUDE_LINES, (p) => {
      id1 = parseClaudeFile(p, "/tmp")!.info.id;
    });
    withTempFile("agent-abc.jsonl", CLAUDE_LINES, (p) => {
      id2 = parseClaudeFile(p, "/tmp")!.info.id;
    });
    expect(id1).not.toBe(id2);
  });
});
