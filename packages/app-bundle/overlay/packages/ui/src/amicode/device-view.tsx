import { For, Show } from "solid-js"
import type { DeviceVerdict } from "./problem"

// AMICODE Device hero (ring-2 verdict-first redesign). device_session has no
// dedicated schema yet — today it carries only pulse_ref/run_dir/note. This
// renders the PROPOSED verdict (connection + provider + ready + queue) when
// those fields land (design-leads-schema-follows), degrading gracefully to the
// pulse/run linkage that exists now. Verdict model is the pure deviceVerdict()
// in ./problem.ts; styling in ./amicode.css. The raw field table stays one
// "Show all fields" disclosure below.

const basename = (p: string): string => p.split("/").filter(Boolean).pop() ?? p

export function DeviceView(props: { verdict: DeviceVerdict }) {
  const v = () => props.verdict
  const hasPills = () =>
    v().connection !== null || v().ready !== null || Boolean(v().provider) || Boolean(v().queue)
  const links = () => {
    const out: { label: string; value: string }[] = []
    const p = v().pulseRef
    if (p) out.push({ label: "pulse", value: basename(p) })
    const r = v().runDir
    if (r) out.push({ label: "run", value: basename(r) })
    return out
  }
  return (
    <div class="amc-device" data-component="amicode-device-view">
      <Show when={hasPills()}>
        <div class="amc-verdict-pills">
          <Show when={v().connection}>
            {(c) => (
              <span
                class="amc-vpill"
                data-slot="amicode-device-connection"
                data-tone={c() === "online" ? "ok" : c() === "offline" ? "critical" : "warn"}
              >
                {c()}
              </span>
            )}
          </Show>
          <Show when={v().ready !== null}>
            <span class="amc-vpill" data-slot="amicode-device-ready" data-tone={v().ready ? "ok" : "warn"}>
              {v().ready ? "ready to run" : "not ready"}
            </span>
          </Show>
          <Show when={v().provider}>{(p) => <span class="amc-vmeta">{p()}</span>}</Show>
          <Show when={v().queue}>{(q) => <span class="amc-vmeta">{q()}</span>}</Show>
        </div>
      </Show>
      <Show when={links().length > 0}>
        <div class="amc-ev-sec">Links</div>
        <div class="amc-device-links" data-slot="amicode-device-links">
          <For each={links()}>
            {(l) => (
              <div class="amc-term">
                <div class="amc-term-head">
                  <span class="amc-term-name">{l.label}</span>
                </div>
                <div class="amc-term-val">{l.value}</div>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={v().note}>{(n) => <div class="amc-device-note">{n()}</div>}</Show>
    </div>
  )
}
