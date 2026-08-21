import { For, Show, createSignal } from "solid-js"
import { amicodeAskBridge } from "./ask-bridge"
import { answeredOption, hasUserReplyAfter, type AskInput } from "./ask"
import { AmicoMark } from "./spinner"
// The session data context moved to packages/session-ui with the message-part
// stack; the card renders inside its provider, so consume it from there.
// (Package-direction irregularity, but module-level acyclic: data.tsx's only
// ui import is the context helper, never the amicode tree.)
import { useData } from "@opencode-ai/session-ui/context"

// AMICODE: question card for amicode_ask tool parts — question text + one
// button per option (with optional dim detail line under each label). Click
// submits the option string as the user's next chat message through the ask
// bridge, then locks the card. Buttons are also disabled once the user has
// replied AFTER this card's message (assistant text streamed after the ask
// does NOT lock it — live-demo fix 2026-07-03), or when no bridge is
// registered. Display label is AMICO (the persona); component/data-*
// identifiers stay amicode-*.

export function AmicodeAskCard(props: { ask: AskInput; messageID?: string; sessionID?: string }) {
  // Answered/picked state derives from the PERSISTED transcript (reopen-safe):
  // the ask-bridge singleton only exists while the header rail is mounted, so
  // it must never gate answerability — it is only the submit transport.
  const [clicked, setClicked] = createSignal<string | undefined>(undefined)
  const data = useData()
  const messages = () => (props.sessionID ? (data.store.message[props.sessionID] ?? []) : [])
  const answered = () => (props.messageID ? hasUserReplyAfter(messages(), props.messageID) : false)
  const persistedPick = () =>
    props.messageID
      ? answeredOption(messages(), (id) => data.store.part[id] ?? [], props.messageID, props.ask.options)
      : undefined
  const picked = () => clicked() ?? persistedPick()

  const active = () => !answered() && !clicked()

  const submit = (option: string) => {
    const bridge = amicodeAskBridge()
    if (!bridge || !active()) return
    setClicked(option)
    bridge.send(option)
  }

  return (
    <div
      data-component="amicode-ask-card"
      style={{
        display: "flex",
        "flex-direction": "column",
        gap: "8px",
        "min-width": "0",
        padding: "8px 12px",
        "font-size": "12px",
        "line-height": "16px",
      }}
    >
      <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
        <span class="amc-sig">
          <AmicoMark />
        </span>
        <span style={{ "font-weight": "600", color: "var(--v2-text-text-base)" }}>Question</span>
      </div>
      <div data-slot="amicode-ask-question" style={{ "font-size": "13px", color: "var(--v2-text-text-base)" }}>
        {props.ask.question}
      </div>
      <div style={{ display: "flex", "flex-wrap": "wrap", gap: "6px" }}>
        <For each={props.ask.options}>
          {(option, index) => (
            <button
              type="button"
              data-slot="amicode-ask-option"
              data-picked={picked() === option ? "true" : undefined}
              disabled={!active()}
              onClick={() => submit(option)}
              style={{
                display: "flex",
                "flex-direction": "column",
                "align-items": "flex-start",
                gap: "2px",
                "text-align": "left",
                border:
                  picked() === option ? "1px solid var(--accent-edge)" : "1px solid var(--v2-border-border-strong)",
                "border-radius": "var(--radius-md)",
                background: "var(--v2-background-bg-layer-02)",
                color: "var(--v2-text-text-base)",
                padding: "4px 8px",
                "font-size": "12px",
                "line-height": "16px",
                cursor: active() ? "pointer" : "default",
                opacity: active() || picked() === option ? "1" : "0.55",
              }}
            >
              <span>{option}</span>
              <Show when={props.ask.details?.[index()]}>
                {(detail) => (
                  <span
                    data-slot="amicode-ask-option-detail"
                    style={{
                      "font-size": "11px",
                      "line-height": "14px",
                      color: "var(--v2-text-text-faint)",
                    }}
                  >
                    {detail()}
                  </span>
                )}
              </Show>
            </button>
          )}
        </For>
      </div>
    </div>
  )
}
