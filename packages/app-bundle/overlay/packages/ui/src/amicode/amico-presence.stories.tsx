// @ts-nocheck
// Self-contained preview of the Amico third-actor presence (spec-20260712).
// Mock data only — NOT wired to real messages — so the interaction/feel is
// reviewable without touching message-part.tsx / entity-rail.tsx (which the
// dashboard agent is actively editing). Shows each presence state + an
// auto-playing pop-in / pop-out sequence.
import { createSignal, onCleanup, onMount, For, Show } from "solid-js"
import { AmicoMark } from "./spinner"
import { ThinkingLine } from "./thinking-line"
import { railVisible, showsWorkingPresence, type PresenceState } from "./amico-presence"
import "./amico-presence.css"

export default {
  title: "Amicode/AmicoPresence",
  id: "amicode-amico-presence",
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: `### Amico as a third actor

Amico pops IN when a turn enters its domain, works, and pops OUT — the rail is
its body (identity + liveness), the message flow is the shared stage (no per-card
AMICO stamps). States: **dormant** (never engaged, rail absent) · **stepping_in**
(rail wakes, presence leans in) · **on** (rail live, thinking line in the lane) ·
**settling** (liveness recedes, artifacts settle, receipt left) · **idle** (rail
persists quiet). Mock data; wiring is a coordinated follow-up.`,
      },
    },
  },
}

const ENTITIES = (state: PresenceState) => {
  const live = state === "on"
  const done = state === "settling" || state === "idle"
  return [
    { name: "System", val: done || live ? "transmon·3lvl" : "", status: done ? "settled" : live ? "live" : "pending" },
    { name: "Formulation", val: done ? "gate" : "", status: done ? "settled" : live ? "live" : "pending" },
    { name: "Run", val: done ? "F=0.99998" : "", status: done ? "settled" : live ? "live" : "pending" },
    { name: "Pulse", val: done ? "412ns" : "", status: done ? "settled" : "pending" },
  ]
}

function MockRail(props: { state: PresenceState }) {
  const live = () => showsWorkingPresence(props.state)
  return (
    <Show when={railVisible(props.state)}>
      <div
        class="amc-sig amc-rail"
        classList={{ "is-waking": props.state === "stepping_in", "is-live": live(), "is-quiet": !live() }}
        style={{ display: "flex", "align-items": "center", gap: "10px", padding: "8px 12px", "border-bottom": "1px solid var(--v2-border-border-base)", "flex-wrap": "wrap" }}
      >
        <AmicoMark running={live()} />
        <span class="amc-wordmark">AMICO</span>
        <span class="amc-livedot" style={{ width: "6px", height: "6px", "border-radius": "50%" }} />
        <span style={{ color: "var(--v2-text-text-muted)", "font-size": "12px" }}>x-gate-transmon-warm ▾</span>
        <For each={ENTITIES(props.state)}>
          {(e) => (
            <span class="amc-entity" data-status={e.status}>
              <span class="amc-entity-dot" />
              {e.name}{e.val ? ` ${e.val}` : " —"}
            </span>
          )}
        </For>
      </div>
    </Show>
  )
}

function MockFlow(props: { state: PresenceState }) {
  return (
    <div style={{ padding: "14px", display: "flex", "flex-direction": "column", gap: "10px", "font-size": "13px", color: "var(--v2-text-text-base)" }}>
      {/* user (right) */}
      <div style={{ "align-self": "flex-end", background: "var(--v2-surface-surface-raised, rgba(127,127,127,0.12))", padding: "6px 10px", "border-radius": "8px", "max-width": "80%" }}>
        optimize an X gate on my transmon — use what you know from my history
      </div>
      {/* normal chat prose (full width) */}
      <Show when={props.state !== "dormant"}>
        <div style={{ color: "var(--v2-text-text-muted)" }}>
          Warm-starting from <span style={{ color: "var(--v2-text-text-accent)" }}>x-gate-transmon-v5</span> (F=0.999972). Here's the plan…
        </div>
      </Show>
      <Show when={props.state === "dormant"}>
        <div style={{ color: "var(--v2-text-text-muted)" }}>The capital of France is Paris. [normal chat — Amico stays offstage]</div>
      </Show>

      {/* Amico lane */}
      <Show when={props.state === "stepping_in" || props.state === "on"}>
        <div class="amc-lane" classList={{ "is-stepping-in": props.state === "stepping_in" }}>
          {/* stepping_in gets a bare lane-head; the thinking block (wave+verb) owns the working indicator now */}
          <Show when={props.state === "stepping_in"}>
            <div class="amc-lane-head"><AmicoMark running />stepping in…</div>
          </Show>
          <Show when={props.state === "on"}>
            <ThinkingLine tokens={2437} />
          </Show>
        </div>
      </Show>
      <Show when={props.state === "settling"}>
        <div class="amc-lane is-settling">
          <div class="amc-lane-head"><AmicoMark /></div>
          <div class="amc-receipt">ran it — <span class="amc-receipt-metric">F=0.99998</span>, 412ns · <span style={{ color: "var(--v2-text-text-accent)" }}>[pulse card]</span> <span style={{ color: "var(--v2-text-text-accent)" }}>[open in inspector]</span></div>
        </div>
      </Show>
    </div>
  )
}

function Stage(props: { state: PresenceState; label?: string }) {
  return (
    <div style={{ "max-width": "720px", border: "1px solid var(--v2-border-border-base)", "border-radius": "10px", overflow: "hidden", "font-family": "var(--text-font, system-ui)" }}>
      <Show when={props.label}>
        <div style={{ padding: "4px 12px", "font-size": "11px", "letter-spacing": "0.08em", color: "var(--v2-text-text-faint)", "text-transform": "uppercase" }}>{props.label}</div>
      </Show>
      <MockRail state={props.state} />
      <MockFlow state={props.state} />
    </div>
  )
}

export const Dormant = () => <Stage state="dormant" label="dormant · off-domain, no Amico" />
export const SteppingIn = () => <Stage state="stepping_in" label="stepping in · rail wakes" />
export const On = () => <Stage state="on" label="on · working, thinking line in lane" />
export const Settling = () => <Stage state="settling" label="settling · liveness recedes, receipt stays" />
export const Idle = () => <Stage state="idle" label="idle · rail persists, quiet" />

// Auto-playing pop-in / pop-out loop so the motion is visible at a glance.
export const FullSequence = () => {
  const order: PresenceState[] = ["dormant", "stepping_in", "on", "on", "settling", "idle", "idle"]
  const [i, setI] = createSignal(0)
  onMount(() => {
    const t = setInterval(() => setI((n) => (n + 1) % order.length), 1800)
    onCleanup(() => clearInterval(t))
  })
  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
      <div style={{ "font-size": "12px", color: "var(--v2-text-text-muted)" }}>▶ {order[i()]}</div>
      <Stage state={order[i()]} />
    </div>
  )
}
