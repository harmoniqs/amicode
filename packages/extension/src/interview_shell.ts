// UX1 live interview (#46) — Amico guides a goal-directed interview; the
// extension renders each question as clickable components and closes the loop
// with a REAL solve. No hardcoded question tree: stages pin GOALS + SLOTS
// (the stage spec below is the agent's instructions); the agent phrases,
// orders, and skips adaptively via opencode's native question tool.
//
//   loop:  POST /session → one long-lived turn (POST /session/{id}/message)
//          questions arrive as native question-tool calls INSIDE that turn —
//          the driver POLLS `GET /question` (sessionID-filtered, deduped) and
//          answers via POST /question/{requestID}/reply; the turn continues
//          server-side across every question REGARDLESS of client connection
//          (proven: a turn kept running after its originating POST died).
//          The résumé lands as the turn's final text (strict JSON). If the
//          model answers with a text-JSON question instead of the tool, the
//          fallback parser renders it — both model behaviors are covered.
//   solve: the résumé's Solve button fills the vetted template DETERMINISTICALLY
//          and spawns amico-run — no LLM in the critical path; the running
//          watcher lights the inspector, convergence triggers save-to-catalog,
//          the pulse lands named+tagged on the card. Downstream all exists.
//
// Relitigation note: the interview-UX spec locked AskUserQuestion for v1 with
// Amicode as the richer renderer "later" — pulled forward with direct team
// sign-off (Kate, 2026-07-03); the conversation runs through opencode's native
// question protocol, so the question SHAPE is AskUserQuestion by construction.

import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { templateEnvelope, fillTemplate, platformFamily, PLATFORM_FAMILIES, TEMPLATE_DELTA_DEFAULT, type InterviewSlots } from "./solve_templates";

// The solve leg's knowledge (what's vetted, how templates fill, physics hints)
// lives in solve_templates.ts as a REGISTRY — adding a modality is a content
// change there, zero interview code. Re-exported so existing callers/tests
// keep one import surface.
export { templateEnvelope, fillTemplate, physicsHints, canonicalGate, platformFamily, PLATFORM_FAMILIES, TEMPLATE_DELTA_DEFAULT, SOLVE_TEMPLATES, TRANSMON_1Q, type InterviewSlots, type TemplateSpec, type EnvelopeResult, type PlatformFamily } from "./solve_templates";

// ---------------------------------------------------------------------------
// Stage spec — the interview's contract (goals + slots), sent to the agent.
// ---------------------------------------------------------------------------

export const INTERVIEW_STAGES = [
  {
    id: "system-setup",
    title: "System Setup",
    goal: "know what physical system this is and what physics the model must include: modality, a user-assigned system name, where device parameters come from, and which Hamiltonian terms matter",
    slots: ["modality (transmon | rydberg/neutral-atom | fluxonium | trapped-ion | bosonic/cavity | NV center | spin qubit | other — ALL are valid interview paths; the PLATFORM PATHS section says which solve in-extension today)", "system_name (user's name for the device, e.g. Emerald-Q3)", "device_source (existing profile | uploaded | manual defaults)", "physics (Hamiltonian terms/effects to include — ask as ONE MULTI-SELECT question (multiple: true) whose options are INDIVIDUAL modality-appropriate terms, e.g. transmon: anharmonicity, tunable coupler, ZZ crosstalk, decoherence; the UI assembles a live Hamiltonian from the selection, so never bundle two terms into one option label)", "device_limits (OPTIONAL — hardware constraints worth honoring: T1/T2 coherence, AWG bandwidth/sample rate, max output; use them to sanity-check T and drive_max)"],
  },
  {
    id: "define-model",
    title: "Define Model",
    goal: "know how faithful the simulation model must be, and in what frame",
    slots: ["levels (per subsystem — scalar for a single qubit, array when the model has multiple subsystems; convention: transmon qubits ≈3 levels, tunable couplers ≈5)", "delta (OPTIONAL — transmon anharmonicity δ in GHz, POSITIVE convention; default 0.2 until device profiles land. A physicist with a real device knows their δ — recording it makes the solved pulse THEIR device's pulse, so ask for it whenever the device is real rather than hypothetical)", "drive_max (per-quadrature bound, GHz; real transmon hardware typically ≈0.05 GHz — the 0.2 GHz demo default is generous, so ask which regime they're in)", "n_drives (usually 2 quadratures)", "frame (OPTIONAL, transmon default: qubit-rotating frame with RWA; capture lab-frame or other choices verbatim)", "modulation (OPTIONAL, default: baseband I/Q on resonance; capture sideband/detuned schemes verbatim)", "bounds (OPTIONAL — anything beyond the symmetric per-quadrature cap: asymmetric bounds, slew-rate/derivative limits)"],
  },
  {
    id: "target",
    title: "Target",
    goal: "know exactly which unitary the pulse must implement",
    slots: ["gate (X | Y | Z | H | S | T | sqrtX — the vetted set; for other unitaries set gate to \"custom\" with the user's description verbatim in gate_spec; for state preparation (|ψ₀⟩→|ψ_goal⟩, a different problem type than a gate) set gate to \"state-prep\" and describe both states in gate_spec. If the user picks Z, S, or T, note in the question description that hardware usually does these as virtual-Z frame updates for free — still solvable as a pulse if they really want one)"],
  },
  {
    id: "problem",
    title: "Problem",
    goal: "know how the search is formulated and its budget",
    slots: ["objective (vetted-default = smooth-pulse baseline: fidelity objective + smoothness regularization | description of extras)", "T (gate time, ns — team-vault prior for transmon 1Q: 15–60 ns realistic, sweet spot ≈34–42 ns; T should GROW with levels, and fidelity ceilings under 80% usually mean T vs truncation, not hyperparameters)", "N (timesteps/knot points — the PRIMARY resolution knob; more often helps fidelity, but not universally)", "max_iter", "followups (OPTIONAL — advanced stages wanted AFTER the baseline: min-time | robustness | leakage suppression; these warm-start from the baseline pulse)"],
  },
] as const;

/** Rough problem-size + wall-time estimate for the résumé. Pure. */
export function estimateProblem(slots: InterviewSlots): { vars: number; estMinutes: string; estMemory: string } {
  // Hilbert dim = product of per-subsystem levels (scalar = single subsystem).
  const dim = (Array.isArray(slots.levels) ? slots.levels : [slots.levels]).reduce((a, b) => a * b, 1);
  const iso = 2 * dim * dim;                                    // iso-vectorized unitary per knot
  const vars = slots.N * (iso + (slots.n_drives ?? 2) * 3 + 1); // states + controls/derivs + Δt
  const estMinutes = vars < 3000 ? "2–3 min" : vars < 10000 ? "5–10 min" : "10+ min";
  // Coarse sparse-KKT bucket — informational (solves route to cloud anyway).
  const estMemory = vars < 5000 ? "<1 GB" : vars < 20000 ? "1–4 GB" : "8+ GB";
  return { vars, estMinutes, estMemory };
}

/** Kickoff prompt: stage goals + the strict JSON turn protocol. Every agent
 *  reply is machine-parsed — one JSON object, nothing else. Pure; exported. */
export function buildKickoffPrompt(): string {
  const stages = INTERVIEW_STAGES.map((s, i) =>
    `${i + 1}. ${s.title} (header: "${s.id}") — goal: ${s.goal}. Slots: ${s.slots.join("; ")}.`).join("\n");
  const platforms = PLATFORM_FAMILIES.map((f) =>
    `- ${f.label}: ${f.status === "vetted" ? "VETTED template — solvable right here" : `working solves live in ${f.demoRepo} — capture faithfully; solvable here once its template lands`}${f.warmStartPolicy ? `. Warm-start doctrine: ${f.warmStartPolicy}` : ""}${f.warmStarts?.length ? `. Catalog seeds: ${f.warmStarts.map((w) => `${w.id} (${w.note})`).join(", ")}` : ""}`).join("\n");
  return `You are Amico, guiding a pulse-design interview. Work through these stages IN ORDER, but adapt freely within them:

${stages}

PLATFORM PATHS — offer ALL of these as modality options (every platform is a valid interview path). Be honest in option descriptions about which solve in-extension today vs which exist as demo-repo physics, and use each family's warm-start doctrine when discussing follow-ups (NEVER suggest warm starts for fluxonium):
${platforms}

PROTOCOL:
- To ask the next question, use the QUESTION TOOL (one call per question): header = the current stage id EXACTLY as given above; a focused question; 2-5 options with the recommended default FIRST (label 1-4 words, description says why). Options must be CONCRETE choices only — NEVER include an "Other"/"custom"/"describe it" option: the chat input below the options is always available for free-form answers and the UI labels it. Never ask questions as plain text.
- When every slot is known, finish the conversation with EXACTLY ONE JSON text object and nothing else (no prose, no code fences, no tool call):
  {"type":"resume","slots":{"modality":"...","system_name":"...","device_source":"...","physics":["anharmonicity"],"levels":3,"drive_max":0.2,"n_drives":2,"gate":"X","objective":"vetted-default","T":10,"N":50,"max_iter":60}}
  (numbers as numbers, no strings for numeric slots; "levels" is per subsystem — a scalar for a single qubit, an array like [3,5,3] when the model includes couplers/multiple subsystems)

Rules:
- ONE question at a time. Single-select by default; the LIST-LIKE slots (physics, followups) are the exception — ask each as ONE multi-select question (set multiple: true) whose options are individual canonical terms (e.g. "anharmonicity", "ZZ crosstalk", "tunable coupler"). The UI renders a live Hamiltonian that updates as the user toggles terms, so option labels must be single terms, never bundles. A multi-select answer arrives as the list of selected labels; custom answers may still carry lists in prose.
- Free-text answers: interpret them into slots yourself (e.g. "two 3-level transmons with a 5-level tunable coupler" → modality transmon, levels [3,5,3], physics includes "tunable coupler").
- Capture the user's system FAITHFULLY even if it exceeds today's vetted solve templates (other modalities, couplers, multi-qubit, custom gates, non-default frames) — never steer them to a simpler system; the extension decides what is solvable.
- OPTIONAL slots (physics extras, device_limits, frame, modulation, bounds, gate_spec): offer the default and move on — only dig in when the user signals they care. Include them in the resume slots only when the user chose something. Use device_limits to sanity-check T and drive_max (e.g. warn inside a question's description if T approaches T2).
- A gate outside X/Y/Z/H/S/T/sqrtX: set "gate":"custom" and record the user's exact description in "gate_spec".
- The workflow is FIDELITY-FIRST: robustness, min-time, and leakage suppression are later stages that warm-start from the baseline smooth pulse — never fold them into the first solve or promise them in it. If the user wants them, say so in the question's description (baseline first, then composed via warm-start) and capture the intent in "followups". (For the record: min-time composes from a free-time baseline with variable timesteps; robustness samples perturbed systems around the warm start.)
- The user may revise any earlier answer at ANY point, including after the resume ("change T to 20"). Update the slots and reply per the protocol — a follow-up question if the change requires one, otherwise the updated resume.
- Do NOT write Julia, do NOT run anything. The extension runs the solve after the user confirms the résumé.
Begin now with the first question.`;
}

// ---------------------------------------------------------------------------

export interface InterviewDeps {
  serverUrl: () => URL | undefined;
  runsRoot: string;
  juliaProject: string;
  amicoRunBinDir?: string;
  channel: vscode.OutputChannel;
}

/** Best-effort activity extraction from an in-flight turn's message parts —
 *  what Amico is doing RIGHT NOW (newest tool call) and which files the turn
 *  has referenced. Defensive by design: opencode part shapes vary by version,
 *  so unknown parts are ignored and nothing is ever invented — no tool parts
 *  means no activity label, and the dock just says "thinking". Pure; exported. */
export function extractActivity(msgs: unknown): { label?: string; files: string[] } {
  const files: string[] = [];
  let label: string | undefined;
  const list = Array.isArray(msgs) ? msgs : [];
  const last = [...list].reverse().find((m) => (m as { info?: { role?: string } })?.info?.role === "assistant") as
    | { parts?: Array<Record<string, unknown>> } | undefined;
  const pathIn = (v: unknown): string | undefined => {
    if (typeof v !== "string" || !/[\\/]|\.\w{1,5}$/.test(v) || /\s{2}|\n/.test(v)) return undefined;
    return v.replace(/^.*[\\/]/, "");
  };
  for (const p of last?.parts ?? []) {
    const type = String(p.type ?? "");
    if (!/tool/.test(type)) continue;
    const name = String((p.tool as string) ?? (p.name as string) ?? "").trim();
    // The question tool IS the interview protocol, not activity — surfacing
    // "question" as what Amico is doing is noise (evidence: it's the only
    // tool today's interview agent ever calls).
    if (/^question$/i.test(name)) continue;
    // File-ish strings live in whichever bag this opencode version uses.
    const bags = [p.input, p.args, (p.state as Record<string, unknown> | undefined)?.input];
    let file: string | undefined;
    for (const bag of bags) {
      if (bag && typeof bag === "object") {
        for (const v of Object.values(bag as Record<string, unknown>)) {
          file ??= pathIn(v);
        }
      }
    }
    if (file && !files.includes(file)) files.push(file);
    if (name) label = file ? `${name} · ${file}` : name;
  }
  return { label, files };
}

/** Extract the protocol JSON from a reply — tolerates code fences and
 *  surrounding whitespace, nothing more. Exported for tests. */
export function extractJson(reply: string): Record<string, unknown> | undefined {
  const trimmed = reply.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try { return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>; }
  catch { return undefined; }
}

export function registerInterview(ctx: vscode.ExtensionContext, deps: InterviewDeps): void {
  ctx.subscriptions.push(vscode.commands.registerCommand("amicode.startInterview", async () => {
    const base = deps.serverUrl();
    if (!base) {
      void vscode.window.showWarningMessage("Amicode: opencode server isn't ready yet.");
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "amicode.interview", "Pulse-Design Interview", vscode.ViewColumn.One,
      {
        enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, "dist"), vscode.Uri.joinPath(ctx.extensionUri, "media")],
      },
    );
    const uri = (...p: string[]) => panel.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, ...p));
    const nonce = Math.random().toString(36).slice(2);
    panel.webview.html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${panel.webview.cspSource} 'unsafe-inline'; font-src ${panel.webview.cspSource};">
<link rel="stylesheet" href="${uri("media", "brand.css")}" />
<link rel="stylesheet" href="${uri("media", "layout.css")}" />
<link rel="stylesheet" href="${uri("media", "vendor", "katex", "katex.min.css")}" />
</head><body>
<script nonce="${nonce}" src="${uri("dist", "interview_webview.js")}"></script>
</body></html>`;

    const driver = new InterviewDriver(base, panel, deps);
    panel.onDidDispose(() => driver.dispose());
    await driver.start();
  }));
}

/** One pending question request from `GET /question` (QuestionRequest). */
interface QuestionRequest {
  id: string;
  sessionID: string;
  questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string }>; custom?: boolean; multiple?: boolean }>;
}

class InterviewDriver {
  private sessionID?: string;
  private turn = 0;
  private turnInFlight = false;
  private turnAbandoned = false;
  private awaitingUser = false;
  private ticking = false;
  private retryCount = 0;
  private turnStartedAt = 0;
  private lastActivity = 0;
  private stallWarned = false;
  private activityTick = 0;
  private lastActivityLabel = "";
  private lastPartsShape = "";
  private readonly seenQuestions = new Set<string>();
  private poller?: NodeJS.Timeout;
  private disposed = false;

  constructor(
    private readonly base: URL,
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: InterviewDeps,
  ) {
    this.panel.webview.onDidReceiveMessage((m) => void this.onWebviewMessage(m));
  }

  private api(p: string): string {
    return new URL(p, this.base).toString();
  }

  private log(line: string): void {
    this.deps.channel.appendLine(`[interview] ${line}`);
  }

  async start(): Promise<void> {
    this.post({ type: "thinking" });
    this.log(`start — server ${this.base}`);
    try {
      const res = await fetch(this.api("/session"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "pulse-design interview" }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`session create HTTP ${res.status}`);
      const session = (await res.json()) as { id?: string };
      if (typeof session.id !== "string" || !session.id) throw new Error("session create returned no id");
      this.sessionID = session.id;
      this.log(`session created ${session.id}`);
      this.beginTurn(buildKickoffPrompt());
    } catch (err) {
      this.log(`start FAILED: ${(err as Error).message}`);
      this.post({ type: "status", text: `couldn't start the interview: ${(err as Error).message}` });
    }
  }

  /** Fire one long-lived turn: POST /session/{id}/message. The turn spans
   *  every question-tool call the agent makes (answered via the poller); its
   *  final text is the résumé. The POST carries NO timeout — a whole interview
   *  can live inside one turn; stall UX comes from the activity watchdog.
   *  (The queue-based /api/.../prompt path needs a connected web client and
   *  silently stalls headless; the question tool blocks the turn until the
   *  reply API answers it — both learned the hard way.) */
  private beginTurn(text: string): void {
    if (!this.sessionID || this.turnInFlight) return;
    this.post({ type: "thinking" });
    this.turnInFlight = true;
    this.turnAbandoned = false;
    this.turnStartedAt = Date.now();
    this.touch();
    this.startPoller();
    this.log(`turn → POST (${text.length} chars)`);
    const t0 = Date.now();
    void fetch(this.api(`/session/${this.sessionID}/message`), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text }] }),
    }).then(async (r) => {
      this.turnInFlight = false;
      if (!r.ok) {
        this.log(`turn ← HTTP ${r.status} after ${Date.now() - t0}ms: ${(await r.text()).slice(0, 300)}`);
        this.post({ type: "status", text: `Amico errored (HTTP ${r.status}). If no question is showing, restart the interview (run the command again).` });
        return;
      }
      const msg = (await r.json()) as { parts?: Array<{ type: string; text?: string }> };
      const reply = (msg.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
      this.log(`turn ← 200 after ${Date.now() - t0}ms (${reply.length} chars)`);
      this.onTurnComplete(reply);
    }).catch((err: Error) => {
      // The connection died — the turn may STILL be running server-side and
      // the poller keeps answering its questions. The recovery poll picks the
      // final text out of the session transcript when the turn completes.
      this.turnInFlight = false;
      this.turnAbandoned = true;
      this.log(`turn transport error after ${Date.now() - t0}ms: ${err.name} ${err.message} — switching to transcript recovery`);
    });
  }

  private touch(): void {
    this.lastActivity = Date.now();
    this.stallWarned = false;
  }

  /** Poll pending question requests (+ stall watchdog). `GET /question` is
   *  sessionID-filtered and deduped, and — unlike SSE — recovers questions
   *  asked while nobody was listening. */
  private startPoller(): void {
    if (this.poller) return;
    this.poller = setInterval(() => void this.pollTick(), 1500);
  }

  private async pollTick(): Promise<void> {
    if (this.disposed || !this.sessionID || this.ticking) return;
    // Idle: questions only arrive while a turn runs (or ran, abandoned).
    if (!this.turnInFlight && !this.turnAbandoned) return;
    this.ticking = true;
    try {
      const res = await fetch(this.api("/question"), { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const requests = (await res.json()) as QuestionRequest[];
        for (const req of requests) {
          if (req.sessionID !== this.sessionID || this.seenQuestions.has(req.id)) continue;
          this.seenQuestions.add(req.id);
          this.touch();
          this.awaitingUser = true;   // ball in the user's court — watchdog off
          this.log(`question ${req.id} [${req.questions[0]?.header ?? "?"}]`);
          this.post({ type: "question", requestID: req.id, questions: req.questions });
        }
      }
    } catch { /* transient poll failure — next tick retries */ }
    try {
      // Activity surfacing: every other tick, read the in-flight turn's parts
      // and show what Amico is actually doing (newest tool call + files
      // referenced). Real server activity also feeds the stall watchdog.
      if ((this.turnInFlight || this.turnAbandoned) && !this.awaitingUser && ++this.activityTick % 2 === 0) {
        try {
          const res = await fetch(this.api(`/session/${this.sessionID}/message`), { signal: AbortSignal.timeout(3000) });
          if (res.ok) {
            const msgs = (await res.json()) as Array<{ info?: { role?: string }; parts?: Array<Record<string, unknown>> }>;
            // EVIDENCE (activity debug): what does the in-flight assistant
            // message actually carry? Logged once per shape change so the
            // channel shows the real part vocabulary of this opencode build.
            const lastA = [...msgs].reverse().find((m) => m?.info?.role === "assistant");
            const shape = (lastA?.parts ?? []).map((p) => `${String(p.type)}${p.tool ? `:${String(p.tool)}` : ""}`).join(",") || "(no parts)";
            if (shape !== this.lastPartsShape) {
              this.lastPartsShape = shape;
              this.log(`activity parts: ${shape}`);
            }
            const { label, files } = extractActivity(msgs);
            const key = `${label ?? ""}|${files.join(",")}`;
            if (label && key !== this.lastActivityLabel) {
              this.lastActivityLabel = key;
              this.touch();   // tool calls progressing = not stalled
              this.post({ type: "activity", label, files });
            }
          }
        } catch { /* transient — next tick retries */ }
      }
      // Recovery: the POST died but the turn kept running server-side — read
      // its ending straight from the session transcript.
      if (this.turnAbandoned && !this.turnInFlight) {
        if (await this.tryRecoverFinalText()) this.turnAbandoned = false;
      }
      // Stall watchdog: warn once when an in-flight (or abandoned) turn has
      // been silent for 3 minutes — never while the ball is in the user's court.
      if ((this.turnInFlight || this.turnAbandoned) && !this.awaitingUser && !this.stallWarned && this.lastActivity && Date.now() - this.lastActivity > 180_000) {
        this.stallWarned = true;
        this.log(`stall: no activity for ${Math.round((Date.now() - this.lastActivity) / 1000)}s`);
        this.post({ type: "status", text: "Amico is taking unusually long — the model server may be busy. Hang on, or restart the interview.", spinning: true });
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Transcript recovery: after a client-side transport failure, the turn's
   *  final text is still in the session — take the newest COMPLETED assistant
   *  message's text. Returns false while the agent is still generating. */
  private async tryRecoverFinalText(): Promise<boolean> {
    if (!this.sessionID) return false;
    try {
      const res = await fetch(this.api(`/session/${this.sessionID}/message`), { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return false;
      const msgs = (await res.json()) as Array<{ info?: { role?: string; time?: { completed?: number } }; parts?: Array<{ type: string; text?: string }> }>;
      const last = [...msgs].reverse().find((m) => m.info?.role === "assistant");
      if (!last?.info?.time?.completed) return false;
      // Watermark: only accept an ending NEWER than the turn we abandoned —
      // recovering an older message would silently drop the user's input
      // (e.g. re-render a stale résumé after a failed revision POST).
      if (last.info.time.completed < this.turnStartedAt - 2000) return false;
      const text = (last.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
      if (!text.trim()) return false;
      this.log(`recovered final text from transcript (${text.length} chars)`);
      this.onTurnComplete(text);
      return true;
    } catch { return false; }
  }

  /** The turn's final text: the résumé (strict JSON) — or, fallback, a
   *  question the model asked as text instead of via the tool. */
  private onTurnComplete(reply: string): void {
    this.touch();
    const json = extractJson(reply);
    this.log(`reply parsed: ${json ? String(json.type) : "PROTOCOL BREAK"}`);
    if (json?.type === "resume" || json?.type === "question") this.retryCount = 0;
    if (json?.type === "resume" && json.slots && typeof json.slots === "object") {
      const slots = json.slots as InterviewSlots;
      const est = estimateProblem(slots);
      const env = templateEnvelope(slots);
      const fam = platformFamily(slots.modality);
      this.awaitingUser = true;
      this.post({
        type: "resume", slots, vars: est.vars, estMinutes: est.estMinutes, estMemory: est.estMemory,
        // Serialize the envelope for the webview: ok/reason + WHICH vetted
        // template will run (the spec object itself stays extension-side).
        envelope: { ok: env.ok, reason: env.reason, template: env.template?.id },
        // Hints belong to the matched template (transmon hints on a rydberg
        // config would be wrong physics) — a blocked résumé gets none.
        hints: env.template?.hints?.(slots) ?? [],
        deltaDefault: TEMPLATE_DELTA_DEFAULT,
        // Platform-family info: warm-start doctrine + catalog seeds (regex
        // stripped — the webview gets plain data).
        family: fam && { label: fam.label, status: fam.status, demoRepo: fam.demoRepo, warmStartPolicy: fam.warmStartPolicy, warmStarts: fam.warmStarts },
      });
      return;
    }
    if (json?.type === "question" && typeof json.question === "string" && Array.isArray(json.options)) {
      this.turn += 1;
      this.awaitingUser = true;
      this.post({ type: "question", requestID: `turn-${this.turn}`, questions: [{
        question: json.question,
        header: String(json.header ?? ""),
        options: (json.options as Array<{ label?: string; description?: string }>).map((o) => ({
          label: String(o.label ?? ""), description: o.description,
        })),
        custom: true,
        multiple: json.multiple === true,   // the physics question stays multi-select through the fallback too
      }] });
      return;
    }
    if (this.retryCount < 2) {
      this.retryCount += 1;
      this.beginTurn("Continue per the protocol: ask the next question with the question tool, or reply with EXACTLY the resume JSON object and nothing else.");
      return;
    }
    this.post({ type: "status", text: "Amico keeps breaking the reply protocol — restart the interview (run the command again)." });
  }

  private async onWebviewMessage(m: Record<string, unknown>): Promise<void> {
    if (m.type === "answer") {
      const requestID = String(m.requestID ?? "");
      const answers = (m.answers as string[][]) ?? [];
      // Path record (proposed instrumentation, local-only).
      this.log(`answer ${requestID} ${JSON.stringify(answers)}`);
      this.post({ type: "thinking" });
      this.awaitingUser = false;
      this.touch();
      if (requestID.startsWith("que")) {
        // Native question-tool answer → the reply API resolves the tool call
        // and the in-flight turn continues server-side.
        try {
          const r = await fetch(this.api(`/question/${requestID}/reply`), {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ answers }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!r.ok) {
            this.log(`reply ← HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
            // Un-see it: if the request is still pending server-side the next
            // poll tick re-renders it; if it's truly gone this is harmless.
            this.seenQuestions.delete(requestID);
            this.post({ type: "status", text: `answer didn't reach Amico (HTTP ${r.status}) — the question will re-appear shortly; if it doesn't, restart the interview.`, spinning: true });
          }
        } catch (err) {
          this.log(`reply FAILED: ${(err as Error).message}`);
          this.seenQuestions.delete(requestID);
          this.post({ type: "status", text: `answer didn't reach Amico (${(err as Error).message}) — the question will re-appear shortly; if it doesn't, restart the interview.`, spinning: true });
        }
      } else {
        // Text-JSON fallback question, or a résumé revision — a fresh turn.
        this.beginTurn(answers.map((a) => a.join(", ")).join(" | "));
      }
    }
    if (m.type === "solve") {
      this.launchSolve(m.slots as InterviewSlots);
    }
  }

  /** Deterministic solve leg: fill the vetted template, spawn amico-run. The
   *  running watcher takes it from there (inspector → save-to-catalog → card). */
  private launchSolve(slots: InterviewSlots): void {
    const env = templateEnvelope(slots);
    if (!env.ok || !env.template) {
      this.post({ type: "status", text: `can't solve this configuration yet: ${env.reason}` });
      return;
    }
    try {
      const templatePath = path.join(this.panelRoot(), "templates", env.template.templateFile);
      const script = fillTemplate(fs.readFileSync(templatePath, "utf8"), slots, env.template);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amicode-solve-"));
      const scriptPath = path.join(dir, "solve.jl");
      fs.writeFileSync(scriptPath, script);

      const launcher = this.deps.amicoRunBinDir ? path.join(this.deps.amicoRunBinDir, "amico-run") : "amico-run";
      const args = [scriptPath, "--runs-root", this.deps.runsRoot, "--project", this.deps.juliaProject];
      this.deps.channel.appendLine(`[interview] solve → ${launcher} ${args.join(" ")}`);
      const child = cp.spawn(launcher, args, { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (b: Buffer) => this.deps.channel.append(`[solve] ${b.toString()}`));
      child.stderr.on("data", (b: Buffer) => this.deps.channel.append(`[solve!] ${b.toString()}`));
      child.on("error", (err) => {
        this.post({ type: "status", text: `solve failed to launch: ${err.message}` });
      });
      this.post({ type: "solving" });
      void vscode.commands.executeCommand("amicode.runInspector.focus").then(undefined, () => undefined);
    } catch (err) {
      this.post({ type: "status", text: `solve failed: ${(err as Error).message}` });
    }
  }

  private panelRoot(): string {
    // extension root: dist/ and templates/ are siblings under the extension dir
    return path.join(__dirname, "..");
  }

  private post(m: unknown): void {
    if (this.disposed) return;
    try { void this.panel.webview.postMessage(m); } catch { /* panel torn down */ }
  }

  dispose(): void {
    this.disposed = true;
    if (this.poller) clearInterval(this.poller);
    const sid = this.sessionID;
    if (!sid) return;
    // Abort releases the turn but does NOT clear pending question requests
    // (verified live) — reject ours explicitly or they leak server-side.
    void (async () => {
      try {
        const res = await fetch(this.api("/question"), { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const requests = (await res.json()) as QuestionRequest[];
          for (const req of requests.filter((r) => r.sessionID === sid)) {
            await fetch(this.api(`/question/${req.id}/reject`), { method: "POST", signal: AbortSignal.timeout(3000) }).catch(() => undefined);
          }
        }
      } catch { /* server gone — nothing to clean */ }
      await fetch(this.api(`/session/${sid}/abort`), { method: "POST" }).catch(() => undefined);
    })();
  }
}
