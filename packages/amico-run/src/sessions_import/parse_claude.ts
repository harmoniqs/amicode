import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  makeSessionInfo,
  makeUserMessage,
  makeAssistantMessage,
  makeTextPart,
  makeReasoningPart,
  makeFilePart,
  makeToolPart,
  type ExportData,
  type MessageInfo,
  type ToolState,
} from "./to_export.js";

interface ClaudeLine {
  type: string;
  uuid?: string;
  parentUuid?: string;
  timestamp?: string | number;
  sessionId?: string;
  session_id?: string;
  cwd?: string;
  message?: { role?: string; content?: unknown; model?: string; id?: string };
  toolUseResult?: unknown;
  gitBranch?: string;
  version?: string;
}

function toMs(ts: unknown): number | undefined {
  if (typeof ts === "number") return ts;
  if (typeof ts === "string") {
    const n = Date.parse(ts);
    if (!Number.isNaN(n)) return n;
    const asNum = Number(ts);
    if (!Number.isNaN(asNum)) return asNum;
  }
  return undefined;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const p of content) {
      if (p && typeof p === "object" && "type" in p) {
        const t = (p as Record<string, unknown>).type;
        if (t === "text" && typeof (p as Record<string, unknown>).text === "string") texts.push(String((p as Record<string, unknown>).text));
        if (t === "input_text" && typeof (p as Record<string, unknown>).text === "string") texts.push(String((p as Record<string, unknown>).text));
        if (t === "output_text" && typeof (p as Record<string, unknown>).text === "string") texts.push(String((p as Record<string, unknown>).text));
        if (t === "tool_result" && typeof (p as Record<string, unknown>).content === "string") texts.push(String((p as Record<string, unknown>).content));
      }
    }
    return texts.join("\n");
  }
  if (content && typeof content === "object" && "text" in content) return String((content as Record<string, unknown>).text);
  return "";
}

export function parseClaudeFile(filePath: string, fallbackDirectory: string): ExportData | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) return null;

  const entries: ClaudeLine[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as ClaudeLine);
    } catch {
      // skip malformed
    }
  }

  // Session identity comes from the FILENAME (unique per file), not the `sessionId`
  // field — Claude Code splits one parent session across the main file plus
  // `agent-*.jsonl` sub-agent files that all share the same `sessionId`. Using the
  // shared field would merge every sub-agent conversation into the parent. The
  // shared `sessionId` is kept as `claude_parent_session` metadata instead.
  const fileId = basename(filePath, ".jsonl");
  const parentSessionId = entries.find((e) => e.sessionId)?.sessionId ?? entries.find((e) => e.session_id)?.session_id;
  const id = fileId || String(parentSessionId ?? "unknown").trim() || "unknown";

  const directory = entries.find((e) => e.cwd)?.cwd ?? fallbackDirectory ?? "";
  const originalDirectory = directory;

  let title = id.slice(0, 8);
  for (const e of entries) {
    if (e.type === "user" && e.message?.content !== undefined) {
      const t = extractTextFromContent(e.message.content);
      if (t.trim()) {
        title = t.trim().slice(0, 80);
        break;
      }
    }
  }

  let timeCreated: number | undefined;
  for (const e of entries) {
    const ms = toMs(e.timestamp);
    if (ms !== undefined) {
      timeCreated = ms;
      break;
    }
  }

  let modelId: string | undefined;
  for (const e of entries) {
    if (e.type === "assistant" && e.message?.model) {
      modelId = String(e.message.model);
      break;
    }
  }

  const gitBranch = entries.find((e) => e.gitBranch)?.gitBranch;
  const version = entries.find((e) => e.version)?.version;

  const info = makeSessionInfo({
    id,
    title,
    directory,
    originalDirectory,
    source: "claude",
    sourcePath: filePath,
    modelId,
    providerID: "anthropic",
    timeCreated,
    extraMetadata: {
      ...(gitBranch ? { gitBranch } : {}),
      ...(version ? { claude_version: version } : {}),
      ...(parentSessionId ? { claude_parent_session: String(parentSessionId) } : {}),
    },
  });

  const messages: ExportData["messages"] = [];
  // callId → mutable tool part, so a later tool_result can complete it
  const toolParts = new Map<string, { state: ToolState }>();
  let lastMessageId = "";

  for (const e of entries) {
    if (e.type !== "user" && e.type !== "assistant") continue;
    const roleRaw = e.message?.role;
    if (!roleRaw) continue;

    const isAssistant = roleRaw === "assistant";
    const timeMs = toMs(e.timestamp);
    const msgId = e.uuid ?? `${id}-${messages.length}`;

    const msgInfo: MessageInfo = isAssistant
      ? makeAssistantMessage({
          id: msgId,
          sessionID: info.id,
          parentID: lastMessageId || "msg_root",
          timeCreated: timeMs,
          modelId,
          providerID: "anthropic",
          cwd: originalDirectory,
        })
      : makeUserMessage({
          id: msgId,
          sessionID: info.id,
          timeCreated: timeMs,
          modelId,
          providerID: "anthropic",
        });

    lastMessageId = msgInfo.id;

    const parts: ExportData["messages"][number]["parts"] = [];
    const content = e.message?.content;

    if (typeof content === "string") {
      if (content) parts.push(makeTextPart({ id: `${msgId}_0`, sessionID: info.id, messageID: msgInfo.id, text: content }));
    } else if (Array.isArray(content)) {
      let idx = 0;
      for (const p of content) {
        if (!p || typeof p !== "object") continue;
        const t = (p as Record<string, unknown>).type;
        const pid = `${msgId}_${idx++}`;
        if (t === "text" || t === "input_text" || t === "output_text") {
          const text = String((p as Record<string, unknown>).text ?? "");
          if (text) parts.push(makeTextPart({ id: pid, sessionID: info.id, messageID: msgInfo.id, text }));
        } else if (t === "thinking") {
          const thinking = String((p as Record<string, unknown>).thinking ?? "");
          if (thinking) parts.push(makeReasoningPart({ id: pid, sessionID: info.id, messageID: msgInfo.id, text: thinking, time: timeMs }));
        } else if (t === "tool_use") {
          const callId = String((p as Record<string, unknown>).id ?? "");
          const name = String((p as Record<string, unknown>).name ?? "unknown");
          const input = ((p as Record<string, unknown>).input ?? {}) as Record<string, unknown>;
          const part = makeToolPart({
            id: pid,
            sessionID: info.id,
            messageID: msgInfo.id,
            callID: callId,
            tool: name,
            state: { status: "running", input, time: { start: timeMs ?? Date.now() } },
          });
          parts.push(part);
          if (callId) toolParts.set(callId, part as unknown as { state: ToolState });
        } else if (t === "tool_result") {
          const callId = String((p as Record<string, unknown>).tool_use_id ?? "");
          const maybeContent = (p as Record<string, unknown>).content;
          const out = typeof maybeContent === "string" ? maybeContent : JSON.stringify(maybeContent ?? "");
          const isError = Boolean((p as Record<string, unknown>).is_error);
          const matched = callId ? toolParts.get(callId) : undefined;
          if (matched) {
            matched.state = isError
              ? { status: "error", input: {}, error: out, time: { start: timeMs ?? Date.now(), end: timeMs ?? Date.now() } }
              : { status: "completed", input: {}, output: out, title: "", metadata: {}, time: { start: timeMs ?? Date.now(), end: timeMs ?? Date.now() } };
          } else {
            parts.push(
              makeToolPart({
                id: pid,
                sessionID: info.id,
                messageID: msgInfo.id,
                callID: callId,
                tool: "unknown",
                state: isError
                  ? { status: "error", input: {}, error: out, time: { start: timeMs ?? Date.now(), end: timeMs ?? Date.now() } }
                  : { status: "completed", input: {}, output: out, title: "", metadata: {}, time: { start: timeMs ?? Date.now(), end: timeMs ?? Date.now() } },
              }),
            );
          }
        } else if (t === "image") {
          const src = (p as Record<string, unknown>).source as Record<string, unknown> | undefined;
          if (src) {
            const mime = String(src.media_type ?? "image/jpeg");
            parts.push(
              makeFilePart({
                id: pid,
                sessionID: info.id,
                messageID: msgInfo.id,
                mime,
                filename: undefined,
                url: `data:${mime};base64,${String(src.data ?? "")}`,
              }),
            );
          }
        }
      }
      if ((e as ClaudeLine).toolUseResult !== undefined && parts.length === 0) {
        const tr = (e as ClaudeLine).toolUseResult;
        parts.push(
          makeToolPart({
            id: `${msgId}_${idx}`,
            sessionID: info.id,
            messageID: msgInfo.id,
            callID: "",
            tool: "unknown",
            state: {
              status: "completed",
              input: {},
              output: typeof tr === "string" ? tr : JSON.stringify(tr),
              title: "",
              metadata: {},
              time: { start: timeMs ?? Date.now(), end: timeMs ?? Date.now() },
            },
          }),
        );
      }
    }

    if (parts.length === 0) continue;
    messages.push({ info: msgInfo, parts });
  }

  if (messages.length === 0) return null;

  return { info, messages };
}
