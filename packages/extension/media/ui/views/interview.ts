// UX1 live interview view (#46) — Amico's questions rendered as stacked
// clickable components with a chat composer pinned at the bottom, ending in
// the résumé and a real solve. The agent guides (goal-directed, adaptive);
// this view renders whatever it asks. Terminal hand-off: the solve lights the
// Run Inspector; convergence triggers save-to-catalog; the pulse lands on the
// card.
//
// LAYOUT CONTRACT (fork-transcript ready): this flow ultimately renders inside
// the opencode-fork transcript — an infinite vertical scroll with a chat input
// at the bottom. So: no side rail (stage identity rides the askframe chip),
// content stacks top-to-bottom, and ALL free-text ("Other" answers, résumé
// revisions) flows through the one bottom composer, routed by context.

import { defineStyle } from "../style";
import { text } from "../atoms/text";
import { loader } from "../atoms/loader";
import { pill } from "../atoms/pill";
import { askframe } from "../components/askframe";
import { hamiltonianPanel } from "../components/hamiltonian";
import { isHamiltonianTerm } from "../components/hamiltonian_terms";

defineStyle("interview", `
  body { margin: 0; font-family: var(--text-font); font-size: var(--text-body);
         color: var(--vscode-foreground); }
  .interview { display: flex; flex-direction: column; gap: var(--space-md);
               padding: var(--space-lg); padding-bottom: 0;
               max-width: 760px; margin: 0 auto;
               min-height: 100vh; box-sizing: border-box; }
  .iv-main { display: flex; flex-direction: column; gap: var(--space-md);
             flex: 1; min-width: 0; justify-content: flex-end; }
  .iv-statusrow { display: flex; align-items: center; gap: var(--space-sm);
                  min-height: 1.4em; }
  .iv-status { color: var(--color-dim); font-style: italic; font-size: var(--text-small); }
  .iv-activity { color: var(--color-dim); font-family: var(--text-mono);
                 font-size: var(--text-small); flex: 1; min-width: 0;
                 white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .iv-dock { position: sticky; bottom: 0; margin-top: auto;
             display: flex; flex-direction: column; gap: var(--space-xs);
             padding: var(--space-sm) 0 var(--space-md);
             background: var(--vscode-editor-background, var(--bg-box)); }
  .iv-composer { display: flex; flex-direction: column; gap: var(--space-sm);
                 border: var(--border-width) solid var(--border-color);
                 border-radius: 12px; padding: var(--space-md);
                 background: var(--vscode-input-background, var(--bg-plot)); }
  .iv-composer:focus-within { border-color: var(--color-accent); }
  .iv-composer input { font-family: var(--text-font); font-size: var(--text-body);
                       color: var(--vscode-input-foreground, var(--vscode-foreground));
                       background: transparent; border: none; outline: none; padding: 0; }
  .iv-composer input::placeholder { color: var(--vscode-input-placeholderForeground, var(--color-dim));
                                    opacity: 1; }
  .iv-composer input:disabled { opacity: 0.5; }
  .iv-composer .cp-controls { display: flex; justify-content: space-between; align-items: center; }
  .iv-composer .cp-plus { font-size: var(--text-value); line-height: 1;
                          color: var(--color-dim); background: none; border: none;
                          padding: 0 var(--space-xs); cursor: default; }
  .iv-composer .cp-send { width: 28px; height: 28px; border-radius: 6px; cursor: pointer;
                          display: inline-flex; align-items: center; justify-content: center;
                          font-size: var(--text-body); line-height: 1;
                          border: 1px solid var(--color-accent);
                          color: var(--color-on-accent, #000);
                          background: var(--color-accent-fill, var(--color-accent)); }
  .iv-composer .cp-send:disabled { opacity: 0.4; cursor: not-allowed; }
  .iv-resume button {
    font-family: var(--text-font); font-size: var(--text-small);
    padding: var(--space-xs) var(--space-md); cursor: pointer;
    border: 1px solid var(--color-accent); border-radius: 2px;
    color: var(--color-on-accent, #000);
    background: var(--color-accent-fill, var(--color-accent)); }
  .iv-resume { display: flex; flex-direction: column; gap: var(--space-md);
               background: var(--bg-box);
               border: var(--border-width) solid var(--border-color);
               border-radius: var(--border-radius); padding: var(--space-lg); }
  .iv-resume .rv-titlerow { display: flex; align-items: center; gap: var(--space-md); }
  .iv-resume .rv-title { font-size: var(--text-hero); font-weight: 600; }
  .iv-resume .rv-note { color: var(--color-dim); font-size: var(--text-small); }
  .iv-resume .rv-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
                        gap: var(--space-sm); font-size: var(--text-small); }
  .iv-resume .rv-kv { display: flex; flex-direction: column; gap: 2px; }
  .iv-resume .rv-kv .k { color: var(--color-dim); font-size: var(--text-label);
                         text-transform: uppercase; letter-spacing: 0.6px; }
  .iv-resume .rv-kv .v { font-family: var(--text-mono); }
  .iv-resume .rv-actions { display: flex; gap: var(--space-sm); }
  .iv-resume .rv-actions button:disabled { opacity: 0.5; cursor: not-allowed; }
  .iv-resume .rv-blocked { color: var(--color-dim); font-size: var(--text-small); }
  .iv-resume .rv-hint { color: var(--color-dim); font-size: var(--text-small); }
  .iv-resume .rv-hint::before { content: "note: "; text-transform: uppercase;
                                font-size: var(--text-label); letter-spacing: 0.5px; }
`);

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

export function createInterview(): { el: HTMLElement } {
  const vscodeApi = acquireVsCodeApi();
  const el = document.createElement("div");
  el.className = "interview";

  const status = text("iv-status", "");
  // Live activity: what the in-flight turn is actually doing (tool calls +
  // referenced files, straight from the session — never invented).
  const activity = text("iv-activity", "");
  const think = loader("Amico is thinking");
  const statusRow = document.createElement("div");
  statusRow.className = "iv-statusrow";
  statusRow.append(think.el, status.el, activity.el);
  const host = document.createElement("div");
  const main = document.createElement("div");
  main.className = "iv-main";
  main.append(host);

  // Bottom dock: the loader/status row rides WITH the chat composer (like a
  // typing indicator), and content bottom-anchors just above it — the chat
  // reading order. The composer is the ONE free-text affordance, routed by
  // context: during a question it carries the "Other" answer; on the résumé
  // a revision request; disabled while Amico holds the ball.
  const composer = document.createElement("div");
  composer.className = "iv-composer";
  const input = document.createElement("input");
  const controls = document.createElement("div");
  controls.className = "cp-controls";
  const plus = document.createElement("button");
  plus.className = "cp-plus";
  plus.textContent = "+";
  plus.disabled = true;
  plus.title = "attachments land with the fork UI";
  const send = document.createElement("button");
  send.className = "cp-send";
  send.textContent = "↑";
  send.setAttribute("aria-label", "send");
  controls.append(plus, send);
  composer.append(input, controls);
  const dock = document.createElement("div");
  dock.className = "iv-dock";
  dock.append(statusRow, composer);
  el.append(main, dock);

  let onFreeText: ((t: string) => void) | undefined;
  function setComposer(fn: ((t: string) => void) | undefined, placeholder: string): void {
    onFreeText = fn;
    input.placeholder = placeholder;
    input.disabled = send.disabled = !fn;
  }
  const submit = (): void => {
    const t = input.value.trim();
    if (!t || !onFreeText) return;
    input.value = "";
    onFreeText(t);
  };
  send.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });

  function thinking(on: boolean, statusText = ""): void {
    think.set(on);
    status.set(statusText);
    activity.set("");   // activity belongs to one turn — never carries over
    if (on) {
      host.replaceChildren();
      setComposer(undefined, "Amico is thinking…");
    }
  }

  function renderQuestion(requestID: string, questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string }>; custom?: boolean; multiple?: boolean }>): void {
    if (!questions.length) return;   // malformed request — never submit an empty reply
    thinking(false);
    // Render sequentially: collect one answer per question, reply once.
    const answers: string[][] = [];
    const step = (i: number, answeredStage?: string): void => {
      if (i >= questions.length) {
        vscodeApi.postMessage({ type: "answer", requestID, answers });
        // The one signal we always have: which stage Amico is working
        // through (tool telemetry lights the activity line only when a
        // future agent actually uses tools).
        thinking(true, answeredStage ? `thinking about ${answeredStage.replace(/-/g, " ")}…` : "");
        return;
      }
      const q = questions[i];
      host.replaceChildren();
      // Physics-flavored multi-select: the model Hamiltonian assembles live
      // under the option cards as terms toggle. Declared before the frame so
      // the toggle hook can reach it; assigned only when terms are on offer.
      let hm: ReturnType<typeof hamiltonianPanel> | undefined;
      const frame = askframe({
        stage: q.header,
        question: q.question,
        options: q.options.map((o, j) => ({ label: o.label, description: o.description, default: j === 0 })),
        // No "Other…" card: the chat composer IS the free-form path — always
        // present, always typable, no mode switch.
        other: false,
        multiple: q.multiple === true,
      }, (value) => {
        answers.push(Array.isArray(value) ? value : [value]);
        step(i + 1, q.header);
      }, (selected) => hm?.set(selected));
      host.append(frame.el);
      if (q.multiple === true && q.options.some((o) => isHamiltonianTerm(o.label))) {
        hm = hamiltonianPanel();
        hm.set(q.options.length ? [q.options[0].label] : []);   // recommended default starts selected
        host.append(hm.el);
      }
      // Composer answers THIS question free-form (same reply slot as a card).
      // The placeholder IS the Other affordance — no card, no mode switch;
      // multi-select questions invite a fuller custom response.
      setComposer((t) => { answers.push([t]); step(i + 1, q.header); }, q.multiple === true ? "Custom response" : "Other");
    };
    step(0);
  }

  interface FamilyInfo { label: string; status: string; demoRepo?: string; warmStartPolicy?: string; warmStarts?: Array<{ id: string; note: string }> }

  function renderResume(slots: Record<string, unknown>, vars: number, estMinutes: string, estMemory: string, envelope?: { ok: boolean; reason?: string; template?: string }, hints: string[] = [], deltaDefault?: number, family?: FamilyInfo): void {
    thinking(false);
    host.replaceChildren();   // a stale question/résumé must never stack under a new one
    const box = document.createElement("div");
    box.className = "iv-resume";
    const titleRow = document.createElement("div");
    titleRow.className = "rv-titlerow";
    titleRow.append(text("rv-title", envelope?.ok === false ? "Résumé — captured" : "Résumé — ready to solve").el);
    // Status pill: WHICH vetted template runs, or where this family's physics
    // lives today (demo repo) — a path, not a dead end.
    if (envelope?.ok && envelope.template) titleRow.append(pill("done", `vetted · ${envelope.template}`).el);
    else if (family?.status === "demo") titleRow.append(pill("idle", "template pending").el);
    box.append(titleRow);
    const grid = document.createElement("div");
    grid.className = "rv-grid";
    const kv = (k: string, v: string): void => {
      const cell = document.createElement("div");
      cell.className = "rv-kv";
      cell.append(text("k", k).el, text("v", v).el);
      grid.append(cell);
    };
    kv("system", String(slots.system_name ?? slots.modality ?? "—"));
    kv("modality", String(slots.modality ?? "—"));
    if (Array.isArray(slots.physics) && slots.physics.length) kv("physics", slots.physics.join(", "));
    if (Array.isArray(slots.device_limits) && slots.device_limits.length) kv("device limits", slots.device_limits.join(", "));
    kv("gate", slots.gate === "custom" ? `custom — ${String(slots.gate_spec ?? "?")}` : String(slots.gate ?? "—"));
    kv("levels", Array.isArray(slots.levels) ? slots.levels.join(" / ") : String(slots.levels ?? "—"));
    // δ is what the solve RUNS with either way — showing the default keeps the
    // résumé honest about whose device the pulse is actually solved for.
    if (/transmon/i.test(String(slots.modality ?? ""))) {
      kv("δ anharmonicity", slots.delta !== undefined ? `${slots.delta} GHz` : `${deltaDefault ?? "—"} GHz (default)`);
    }
    if (slots.frame) kv("frame", String(slots.frame));
    if (slots.modulation) kv("modulation", String(slots.modulation));
    if (slots.bounds) kv("bounds", String(slots.bounds));
    kv("T", `${slots.T} ns`);
    kv("N", String(slots.N ?? "—"));
    kv("drive max", `${slots.drive_max} GHz`);
    kv("objective", String(slots.objective ?? "vetted default"));
    if (Array.isArray(slots.followups) && slots.followups.length) kv("after baseline", slots.followups.join(" → "));
    kv("problem size", `~${vars.toLocaleString()} decision vars`);
    kv("est. time", estMinutes);
    kv("est. memory", estMemory);
    // Which vetted template the deterministic solve leg will run — honest
    // provenance, and the row a rydberg/coupler user will watch appear when
    // their family's template lands in the registry.
    if (envelope?.ok && envelope.template) kv("template", envelope.template);
    // Warm-start paths: catalog seeds + the family's doctrine (per-platform —
    // fluxonium says cold-only, rydberg baselines from J-P).
    if (family?.warmStarts?.length) kv("warm starts", family.warmStarts.map((w) => `${w.id} (${w.note})`).join(" · "));
    box.append(grid);
    if (family?.warmStartPolicy) box.append(text("rv-note", `warm-start doctrine: ${family.warmStartPolicy}`).el);
    if (family?.status === "demo" && family.demoRepo) box.append(text("rv-note", `${family.label} solves live in ${family.demoRepo} — this configuration is captured and ready for its template`).el);
    for (const h of hints) box.append(text("rv-hint", h).el);

    const actions = document.createElement("div");
    actions.className = "rv-actions";
    const solve = document.createElement("button");
    solve.textContent = "Solve";
    const blocked = envelope ? !envelope.ok : false;
    solve.disabled = blocked;
    if (blocked) solve.title = envelope?.reason ?? "";
    solve.addEventListener("click", () => {
      solve.disabled = true;   // synchronous — a double-click must not spawn two solves
      vscodeApi.postMessage({ type: "solve", slots });
    });
    actions.append(solve);
    box.append(actions);
    if (blocked) box.append(text("rv-blocked", `Can't solve this configuration yet: ${envelope?.reason ?? ""} Adjust via the chat below, or it stays captured for a future template.`).el);
    if (!blocked) box.append(text("iv-status", "Solving runs the vetted template with these parameters — watch the Run Inspector.").el);
    host.append(box);

    // Revision through Amico itself, via the ONE chat composer — no per-field forms.
    setComposer((t) => {
      vscodeApi.postMessage({ type: "answer", requestID: "revise", answers: [[t]] });
      thinking(true, "updating the résumé…");
    }, 'change something? e.g. "make T 20 ns" or "gate H instead"');
  }

  window.addEventListener("message", (e) => {
    const m = e.data ?? {};
    switch (m.type) {
      case "thinking": thinking(true); break;
      // Errors stop the spinner; stall warnings (spinning: true) keep it.
      case "status": think.set(Boolean(m.spinning)); status.set(String(m.text ?? "")); break;
      case "activity": {
        const files = (m.files as string[] | undefined)?.slice(-3) ?? [];
        activity.set(`${String(m.label ?? "")}${files.length ? ` — referenced: ${files.join(", ")}` : ""}`);
        break;
      }
      case "question": renderQuestion(String(m.requestID), m.questions ?? []); break;
      case "resume": renderResume(m.slots ?? {}, Number(m.vars ?? 0), String(m.estMinutes ?? ""), String(m.estMemory ?? "—"), m.envelope, m.hints ?? [], m.deltaDefault, m.family); break;
      case "solving":
        host.replaceChildren();
        think.set(false);
        status.set("Solve launched — the Run Inspector is streaming it. On convergence you'll be prompted to save to the catalog.");
        setComposer(undefined, "solve running — watch the Run Inspector");
        break;
    }
  });

  thinking(true);
  return { el };
}
