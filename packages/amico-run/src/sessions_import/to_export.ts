// ExportData types matching opencode's canonical import contract
// (`opencode/packages/opencode/src/cli/cmd/import.ts`). The importer decodes
// `info` via `Session.Info`, each message via `SessionV1.Info` (User|Assistant),
// and each part via `SessionV1.Part` — all STRICT schemas. Anything we emit that
// violates them throws at import time, which is exactly the safety net we want:
// a shape bug fails loudly instead of writing rows the UI can't render.
//
// The strict schemas force three things Claude/Codex JSONL never has:
//   - branded IDs: session `ses_*`, message `msg_*`, part `prt_*`
//   - assistant messages carry `parentID`, `modelID`, `providerID`, `mode`,
//     `agent`, `path`, `cost`, and a full `tokens` object
//   - tool parts carry a `state` discriminated union (not flat input/output)
//
// Every builder below synthesizes those from what the source format gives us.

export interface SessionInfo {
  id: string;
  slug: string;
  title: string;
  version: string;
  directory: string;
  path?: string;
  model?: { id: string; providerID: string; variant?: string };
  metadata?: Record<string, unknown>;
  agent?: string;
  time: { created: number; updated: number };
}

export interface MessageInfo {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  time: { created: number; completed?: number };
  agent: string;
  model?: { providerID: string; modelID: string; variant?: string };
  // assistant-only
  parentID?: string;
  modelID?: string;
  providerID?: string;
  mode?: string;
  path?: { cwd: string; root: string };
  cost?: number;
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
}

export type PartInfo =
  | { id: string; sessionID: string; messageID: string; type: "text"; text: string }
  | { id: string; sessionID: string; messageID: string; type: "reasoning"; text: string; time: { start: number; end: number } }
  | { id: string; sessionID: string; messageID: string; type: "file"; mime: string; filename?: string; url: string }
  | { id: string; sessionID: string; messageID: string; type: "tool"; callID: string; tool: string; state: ToolState };

export type ToolState =
  | { status: "pending"; input: Record<string, unknown>; raw: string }
  | { status: "running"; input: Record<string, unknown>; time: { start: number } }
  | { status: "completed"; input: Record<string, unknown>; output: string; title: string; metadata: Record<string, unknown>; time: { start: number; end: number } }
  | { status: "error"; input: Record<string, unknown>; error: string; time: { start: number; end: number } };

export interface ExportData {
  info: SessionInfo;
  messages: Array<{ info: MessageInfo; parts: PartInfo[] }>;
}

// ── ID synthesis ────────────────────────────────────────────────────────────

/** Brand a foreign id into a valid opencode SessionID ("ses_" prefix). */
export function sessionId(original: string): string {
  const clean = original.replace(/[^A-Za-z0-9._-]/g, "");
  return `ses_${clean || Date.now().toString(36)}`;
}

/** Brand a foreign id into a valid opencode MessageID ("msg_" prefix). */
export function messageId(seed: string): string {
  const clean = seed.replace(/[^A-Za-z0-9._-]/g, "");
  return `msg_${clean || Date.now().toString(36)}`;
}

/** Brand a foreign id into a valid opencode PartID ("prt_" prefix). */
export function partId(seed: string): string {
  const clean = seed.replace(/[^A-Za-z0-9._-]/g, "");
  return `prt_${clean}`;
}

const EMPTY_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

// ── Builders ───────────────────────────────────────────────────────────────

export function makeSessionInfo(opts: {
  id: string;
  title: string;
  directory: string;
  originalDirectory?: string;
  source: string;
  sourcePath: string;
  modelId?: string;
  providerID?: string;
  timeCreated?: number;
  extraMetadata?: Record<string, unknown>;
}): SessionInfo {
  const created = opts.timeCreated ?? Date.now();
  return {
    id: sessionId(opts.id),
    slug: opts.id.slice(0, 8),
    title: truncateTitle(opts.title),
    version: "1",
    directory: opts.directory,
    model: opts.modelId ? { id: opts.modelId, providerID: opts.providerID ?? "unknown" } : undefined,
    metadata: {
      import_source: opts.source,
      import_source_path: opts.sourcePath,
      original_directory: opts.originalDirectory ?? opts.directory,
      ...(opts.extraMetadata ?? {}),
    },
    time: { created, updated: Date.now() },
  };
}

export function makeUserMessage(opts: {
  id: string;
  sessionID: string;
  timeCreated?: number;
  modelId?: string;
  providerID?: string;
}): MessageInfo {
  return {
    id: messageId(opts.id),
    sessionID: opts.sessionID,
    role: "user",
    time: { created: opts.timeCreated ?? Date.now() },
    agent: "import",
    model: { providerID: opts.providerID ?? "unknown", modelID: opts.modelId ?? "unknown" },
  };
}

export function makeAssistantMessage(opts: {
  id: string;
  sessionID: string;
  parentID: string;
  timeCreated?: number;
  modelId?: string;
  providerID?: string;
  cwd?: string;
}): MessageInfo {
  const created = opts.timeCreated ?? Date.now();
  const root = opts.cwd ?? "/";
  return {
    id: messageId(opts.id),
    sessionID: opts.sessionID,
    role: "assistant",
    time: { created },
    agent: "import",
    parentID: opts.parentID,
    modelID: opts.modelId ?? "unknown",
    providerID: opts.providerID ?? "unknown",
    mode: "import",
    path: { cwd: root, root },
    cost: 0,
    tokens: EMPTY_TOKENS,
  };
}

export function makeTextPart(opts: { id: string; sessionID: string; messageID: string; text: string }): PartInfo {
  return { id: partId(opts.id), sessionID: opts.sessionID, messageID: opts.messageID, type: "text", text: opts.text };
}

export function makeReasoningPart(opts: { id: string; sessionID: string; messageID: string; text: string; time?: number }): PartInfo {
  const t = opts.time ?? Date.now();
  return { id: partId(opts.id), sessionID: opts.sessionID, messageID: opts.messageID, type: "reasoning", text: opts.text, time: { start: t, end: t } };
}

export function makeFilePart(opts: { id: string; sessionID: string; messageID: string; mime: string; filename?: string; url: string }): PartInfo {
  return { id: partId(opts.id), sessionID: opts.sessionID, messageID: opts.messageID, type: "file", mime: opts.mime, filename: opts.filename, url: opts.url };
}

export function makeToolPart(opts: {
  id: string;
  sessionID: string;
  messageID: string;
  callID: string;
  tool: string;
  state: ToolState;
}): PartInfo {
  return { id: partId(opts.id), sessionID: opts.sessionID, messageID: opts.messageID, type: "tool", callID: opts.callID, tool: opts.tool, state: opts.state };
}

export function truncateTitle(s: string, max = 80): string {
  const t = s.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}
