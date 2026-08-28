import { readFileSync } from "node:fs";
import {
  makeSessionInfo,
  makeUserMessage,
  makeAssistantMessage,
  makeTextPart,
  makeReasoningPart,
  makeToolPart,
  type ExportData,
  type MessageInfo,
  type PartInfo,
  type ToolState,
} from "./to_export.js";

interface CodexLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

function toMs(ts: unknown): number | undefined {
  if (typeof ts === "string") {
    const n = Date.parse(ts);
    if (!Number.isNaN(n)) return n;
  }
  if (typeof ts === "number") return ts;
  return undefined;
}

export function parseCodexFile(filePath: string, _fallbackDirectory: string): ExportData | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) return null;

  let codexSessionId = "";
  let directory = "";
  let cliVersion: string | undefined;
  let modelProvider: string | undefined;
  let timeCreated: number | undefined;

  // First pass: header (session_meta) + title enrichment
  for (const line of lines) {
    let obj: CodexLine;
    try {
      obj = JSON.parse(line) as CodexLine;
    } catch {
      continue;
    }
    if (!timeCreated && obj.timestamp) timeCreated = toMs(obj.timestamp);
    if (obj.type === "session_meta" && obj.payload) {
      const p = obj.payload;
      codexSessionId = String(p.session_id ?? p.id ?? codexSessionId);
      directory = String(p.cwd ?? directory);
      cliVersion = String(p.cli_version ?? cliVersion ?? "");
      modelProvider = String(p.model_provider ?? modelProvider ?? "");
    }
  }

  // Session identity comes from the FILENAME UUID (unique per rollout), not the
  // `session_id` field — Codex writes multiple `rollout-*.jsonl` files for one
  // stable session, each with the SAME session_id. Using that field would merge
  // every rollout into one session. The stable session_id is kept as
  // `codex_session_id` metadata instead.
  const fileUuid = filePath.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1];
  const originalSessionId = fileUuid ?? codexSessionId ?? `codex-${Date.now()}`;
  if (!directory) directory = _fallbackDirectory ?? "";
  const originalDirectory = directory;

  const messages: ExportData["messages"] = [];
  const pendingToolCalls = new Map<string, { state: ToolState }>();
  let msgSeq = 0;
  let lastMessageId = "";

  const ensureMessage = (role: "user" | "assistant", ms: number | undefined, idHint?: string): { idx: number; msgId: string } => {
    const msgId = idHint ?? `${originalSessionId}-msg-${msgSeq++}`;
    const msgInfo: MessageInfo =
      role === "assistant"
        ? makeAssistantMessage({
            id: msgId,
            sessionID: "",
            parentID: lastMessageId || "msg_root",
            timeCreated: ms,
            modelId: modelProvider ? `codex/${modelProvider}` : "codex",
            providerID: modelProvider ?? "openai",
            cwd: originalDirectory,
          })
        : makeUserMessage({
            id: msgId,
            sessionID: "",
            timeCreated: ms,
            modelId: modelProvider ? `codex/${modelProvider}` : "codex",
            providerID: modelProvider ?? "openai",
          });
    lastMessageId = msgInfo.id;
    messages.push({ info: msgInfo, parts: [] });
    return { idx: messages.length - 1, msgId: msgInfo.id };
  };

  // Second pass: messages. sessionID is filled in after we know the final session id.
  for (const line of lines) {
    let obj: CodexLine;
    try {
      obj = JSON.parse(line) as CodexLine;
    } catch {
      continue;
    }
    const ms = toMs(obj.timestamp);
    const payload = obj.payload ?? {};

    if (obj.type === "response_item") {
      const ptype = String(payload.type ?? "");
      if (ptype === "message") {
        const roleRaw = String(payload.role ?? "assistant");
        const role: "user" | "assistant" = roleRaw === "assistant" ? "assistant" : "user";
        const content = payload.content;
        const idHint = typeof payload.id === "string" ? String(payload.id) : undefined;
        const { idx, msgId } = ensureMessage(role, ms, idHint);
        if (Array.isArray(content)) {
          for (const c of content) {
            if (!c || typeof c !== "object") continue;
            const ctype = String((c as Record<string, unknown>).type ?? "");
            if (ctype === "input_text" || ctype === "output_text" || ctype === "text") {
              const text = String((c as Record<string, unknown>).text ?? "");
              if (text) messages[idx].parts.push(makeTextPart({ id: `${msgId}_${messages[idx].parts.length}`, sessionID: "", messageID: msgId, text }));
            }
          }
        } else if (typeof content === "string" && (content as string).trim()) {
          messages[idx].parts.push(makeTextPart({ id: `${msgId}_0`, sessionID: "", messageID: msgId, text: String(content) }));
        }
        if (messages[idx].parts.length === 0) {
          messages.pop();
          msgSeq--;
        }
      } else if (ptype === "custom_tool_call") {
        const callId = String(payload.call_id ?? payload.id ?? `call-${msgSeq}`);
        const name = String(payload.name ?? "exec");
        const input = (payload.input ?? {}) as Record<string, unknown>;
        let targetIdx = messages.length - 1;
        let targetMsgId = "";
        if (targetIdx >= 0 && messages[targetIdx].info.role === "assistant") {
          targetMsgId = messages[targetIdx].info.id;
        } else {
          const { idx, msgId } = ensureMessage("assistant", ms);
          targetIdx = idx;
          targetMsgId = msgId;
        }
        const part = makeToolPart({
          id: `${targetMsgId}_tool_${callId}`,
          sessionID: "",
          messageID: targetMsgId,
          callID: callId,
          tool: name,
          state: { status: "running", input, time: { start: ms ?? Date.now() } },
        });
        messages[targetIdx].parts.push(part);
        pendingToolCalls.set(callId, part as unknown as { state: ToolState });
      } else if (ptype === "custom_tool_call_output") {
        const callId = String(payload.call_id ?? "");
        const output = payload.output;
        let outText = "";
        if (Array.isArray(output)) {
          for (const o of output) {
            if (o && typeof o === "object" && typeof (o as Record<string, unknown>).text === "string") outText += String((o as Record<string, unknown>).text) + "\n";
            else if (typeof o === "string") outText += o + "\n";
          }
        } else if (typeof output === "string") outText = output;
        else if (output !== undefined) outText = JSON.stringify(output);

        const pending = pendingToolCalls.get(callId);
        if (pending) {
          pending.state = {
            status: "completed",
            input: {},
            output: outText,
            title: "",
            metadata: {},
            time: { start: ms ?? Date.now(), end: ms ?? Date.now() },
          };
        } else {
          let targetIdx = messages.length - 1;
          let targetMsgId = targetIdx >= 0 ? messages[targetIdx].info.id : "";
          if (targetIdx < 0 || messages[targetIdx].info.role !== "assistant") {
            const { idx, msgId } = ensureMessage("assistant", ms);
            targetIdx = idx;
            targetMsgId = msgId;
          }
          messages[targetIdx].parts.push(
            makeToolPart({
              id: `${targetMsgId}_out_${callId}`,
              sessionID: "",
              messageID: targetMsgId,
              callID: callId,
              tool: "unknown",
              state: { status: "completed", input: {}, output: outText, title: "", metadata: {}, time: { start: ms ?? Date.now(), end: ms ?? Date.now() } },
            }),
          );
        }
      } else if (ptype === "reasoning") {
        const summary = payload.summary;
        const enc = String(payload.encrypted_content ?? "");
        const text = Array.isArray(summary)
          ? summary.map((s) => (typeof s === "object" && s !== null ? String((s as Record<string, unknown>).text ?? "") : "")).join("\n")
          : enc.slice(0, 200);
        if (text.trim()) {
          let targetIdx = messages.length - 1;
          let targetMsgId = targetIdx >= 0 ? messages[targetIdx].info.id : "";
          if (targetIdx < 0 || messages[targetIdx].info.role !== "assistant") {
            const { idx, msgId } = ensureMessage("assistant", ms);
            targetIdx = idx;
            targetMsgId = msgId;
          }
          messages[targetIdx].parts.push(makeReasoningPart({ id: `${targetMsgId}_reasoning_${messages[targetIdx].parts.length}`, sessionID: "", messageID: targetMsgId, text, time: ms }));
        }
      }
    } else if (obj.type === "event_msg") {
      const etype = String(payload.type ?? "");
      if (etype === "agent_message" || etype === "agent_reasoning") {
        const text = String((payload as Record<string, unknown>).message ?? (payload as Record<string, unknown>).text ?? "");
        if (text.trim()) {
          const { idx, msgId } = ensureMessage("assistant", ms);
          messages[idx].parts.push(makeTextPart({ id: `${msgId}_0`, sessionID: "", messageID: msgId, text }));
        }
      } else if (etype === "user_message") {
        const text = String((payload as Record<string, unknown>).message ?? "");
        if (text.trim()) {
          const { idx, msgId } = ensureMessage("user", ms);
          messages[idx].parts.push(makeTextPart({ id: `${msgId}_0`, sessionID: "", messageID: msgId, text }));
        }
      }
    }
  }

  const pruned = messages.filter((m) => m.parts.length > 0);
  if (pruned.length === 0) return null;

  const firstUserText = pruned.find((m) => m.info.role === "user")?.parts.find((p) => p.type === "text")?.text;
  const title = firstUserText?.slice(0, 80) ?? originalSessionId.slice(0, 24);

  const info = makeSessionInfo({
    id: originalSessionId,
    title,
    directory,
    originalDirectory,
    source: "codex",
    sourcePath: filePath,
    modelId: modelProvider ? `codex/${modelProvider}` : "codex",
    providerID: modelProvider ?? "openai",
    timeCreated,
    extraMetadata: {
      cli_version: cliVersion,
      model_provider: modelProvider,
      ...(codexSessionId ? { codex_session_id: codexSessionId } : {}),
    },
  });

  // Backfill sessionID (and part sessionID) now that the final session id is known.
  for (const m of pruned) {
    m.info.sessionID = info.id;
    for (const p of m.parts) p.sessionID = info.id;
  }

  return { info, messages: pruned };
}
