import { For, Show, createMemo } from "solid-js"
import katex from "katex"
import { systemProjection } from "./problem"
import { formatSci } from "./facets"
import { systemTableModel, systemHamiltonian, systemCountLabel, componentPhysicsRows, PARAM_SYMBOL } from "./system-render"

// AMICODE System hero (spec §6.1) — PHYSICS-FORWARD (Kate 2026-07-23): lead with
// the Hamiltonian, then the physics spec for the component's ROLE. Params the
// role has but nobody has stated read "not set", so an under-specified model is
// visible at a glance; params the role does NOT have are absent entirely (the
// spec used to be a fixed transmon list, which asked Rydberg atoms for their
// anharmonicity). Multi-component systems show the component/coupling table (it
// scales; the node/edge schematic was removed — Kate 2026-07-24). Thin — logic
// in the pure systemProjection / system-render models.

// Drop unset (zero) params — "ω 0 · δ 0" is noise — and format the rest with
// the π-aware formatter so a drive bound reads "|u| 40π", not "|u| 125.66…".
const paramsText = (params: Record<string, number>): string =>
  Object.entries(params)
    .filter(([, v]) => typeof v === "number" && v !== 0)
    .map(([k, v]) => `${PARAM_SYMBOL[k] ?? k} ${formatSci(v)}`)
    .join(" · ")

export function SystemComposite(props: { entity: Record<string, unknown> }) {
  const proj = createMemo(() => systemProjection(props.entity))
  const table = createMemo(() => systemTableModel(proj()))
  const hamiltonian = createMemo(() => {
    const h = systemHamiltonian(proj())
    return h ? { ...h, html: katex.renderToString(h.latex, { throwOnError: false }) } : undefined
  })
  // Single qubit/atom, no couplings → the physics spec. Else the structural view.
  const single = createMemo(() => proj().components.length === 1 && proj().couplings.length === 0)
  const physics = createMemo(() => {
    const c = table().components[0]
    return c ? componentPhysicsRows(c, proj().platform) : []
  })

  return (
    <div class="amc-system" data-component="amicode-system-view">
      <Show when={proj().platform || proj().driveArch || systemCountLabel(proj())}>
        <div class="amc-modebar" data-slot="amicode-system-identity">
          <Show when={proj().platform}>{(p) => <span class="amc-badge">{p()}</span>}</Show>
          {/* N is a claim, not a layout detail — say it so an unanswered "how
              many atoms?" can't read as a confident "one". */}
          <Show when={systemCountLabel(proj())}>{(n) => <span class="amc-badge">{n()}</span>}</Show>
          <Show when={proj().driveArch}>{(d) => <span class="amc-badge">{d()} drive</span>}</Show>
        </div>
      </Show>

      {/* A recorded model is shown bare — it is what the researcher confirmed.
          An INFERRED one is a guess about physics nobody stated, so it says so
          and invites the correction; that correction is what gets recorded. */}
      <Show
        when={hamiltonian()}
        fallback={
          <Show when={proj().components.length > 0}>
            <div class="amc-ev-sec">
              Hamiltonian <span class="amc-ev-sec-note">not recorded</span>
            </div>
            <div class="amc-ev-formula is-empty" data-slot="amicode-system-hamiltonian">
              No model for this platform yet — tell Amico the terms and it'll record them here.
            </div>
          </Show>
        }
      >
        {(h) => (
          <>
            <div class="amc-ev-sec">
              Hamiltonian
              <Show when={h().source === "inferred"}>
                <span class="amc-ev-sec-note">inferred · confirm or correct</span>
              </Show>
            </div>
            <div class="amc-ev-formula" data-slot="amicode-system-hamiltonian" data-source={h().source}>
              <div innerHTML={h().html} />
            </div>
            <Show when={h().notes}>{(n) => <div class="amc-ev-formula-note">{n()}</div>}</Show>
          </>
        )}
      </Show>

      <Show
        when={single()}
        fallback={
          <div class="amc-systbl" data-slot="amicode-system-table">
            <For each={table().components}>
              {(c) => (
                <div class="amc-systbl-row">
                  <span class="amc-c-id">{c.id}</span>
                  <span class="amc-c-role">{c.role}</span>
                  <Show when={c.levels !== undefined}>
                    <span class="amc-c-lvl">{c.levels} lvl</span>
                  </Show>
                  <span class="amc-c-params">{paramsText(c.params)}</span>
                </div>
              )}
            </For>
            <For each={table().couplings}>
              {(cp) => (
                <div class="amc-systbl-row amc-coupling">
                  <span class="amc-c-id">{cp.between.join(" ↔ ")}</span>
                  <span class="amc-c-role">{cp.kind}</span>
                  <span class="amc-c-params">{paramsText(cp.params)}</span>
                </div>
              )}
            </For>
          </div>
        }
      >
        <>
          <div class="amc-ev-sec">Physics</div>
          <div class="amc-sys-physics" data-slot="amicode-system-physics">
            <For each={physics()}>
              {(r) => (
                <div class="amc-term">
                  <div class="amc-term-head">
                    <span class="amc-term-name">{r.label}</span>
                  </div>
                  <div class="amc-term-val" classList={{ "is-unset": r.state === "missing" }}>
                    <span>{r.value}</span>
                    <Show when={r.sym}>{(s) => <span class="amc-term-sym">{s()}</span>}</Show>
                  </div>
                </div>
              )}
            </For>
          </div>
        </>
      </Show>
    </div>
  )
}
