import { For, Show, createEffect } from "solid-js"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useSDK } from "@/context/sdk"
import { amicodePost } from "@/utils/amicode-fetch"
import { showToast } from "@/utils/toast"
import { liveHarnessState, refreshHarnessState, harnessRoute } from "@/components/prompt-input/harness"
import { beginHarnessSwitch } from "@/components/harness-switch-banner"

// amicode#1549 — the harness switcher in the chat box. A fourth composer
// select-slot riding the solver-mode trio: the state comes from the engine's
// GET /amicode/harness (the extension-published registry view — ONE registry,
// the same serialization the palette command renders); the write path is
// POST /amicode/harness, whose switching file the extension watcher performs.
// An unresolvable or unentitled harness renders disabled WITH its reason —
// never selectable-then-failing. No published registry (stock opencode, or
// the extension not yet booted) renders nothing at all.
//
// amicode#1799 — /amicode/harness is an INSTANCE route, so both the mount-path
// GET and the switch POST carry the placement directory (harnessRoute) — the
// key every other instance-scoped fetch the composer makes rides. The bare
// ask only ever worked in the local posture (the panel origin's extension
// proxy forwards to its bound engine); at the hub origin it landed on the
// default backend and was answered with the SPA index, so the control never
// rendered. The fetch/parse/adopt body lives in harness.ts (testable without
// a DOM); this component is the wiring.

/** The palette's disclosure, carried verbatim to the point of switching. */
const DISCLOSURE = "Sessions are harness-local — switching harnesses switches session history."

export function HarnessComposerControl() {
  const server = useServer()
  const sdk = useServerSDK()
  // The instance placement directory — the per-directory SDK context the
  // composer already lives under (the same source the agent/model fetches
  // ride), so the harness ask routes exactly like every other composer fetch.
  const dirSdk = useSDK()
  const directory = () => dirSdk().directory

  // Refetch on server change and on every (re)connect — a harness switch
  // restarts the server, so the post-restart reconnect is when the new
  // current lands here.
  createEffect(() => {
    if (server.current) void refreshHarnessState(server, directory())
  })
  createEffect(() => {
    if (sdk().event.status() === "connected") void refreshHarnessState(server, directory())
  })

  const onPick = async (id: string) => {
    const state = liveHarnessState()
    if (!state || id === state.harness) return
    const conn = server.current
    if (!conn) return
    try {
      const res = (await amicodePost(conn, harnessRoute(directory()), { harness: id })) as {
        ok?: unknown
        noop?: unknown
        harness?: unknown
        error?: unknown
      }
      if (res.ok !== true || typeof res.harness !== "string") {
        showToast({
          variant: "error",
          title: "Amicode: harness switch failed",
          description: typeof res.error === "string" ? res.error : "The switch could not be requested.",
        })
        return
      }
      if (res.noop === true) return
      // Narrate the restart this is about to trigger — the extension watcher
      // is the durable half; the banner carries the webview through the gap.
      const picked = state.options.find((option) => option.id === res.harness)
      beginHarnessSwitch(picked?.displayName ?? res.harness)
    } catch (e) {
      showToast({
        variant: "error",
        title: "Amicode: harness switch failed",
        description: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return (
    <Show when={liveHarnessState()}>
      {(state) => (
        <TooltipV2 placement="top" gutter={4} value="Choose harness">
          <MenuV2 gutter={6} modal={false} placement="top-start">
            <MenuV2.Trigger
              as={ButtonV2}
              variant="ghost-muted"
              size="normal"
              class="max-w-[220px] justify-start ![font-weight:440]"
              aria-label="Choose harness"
              data-action="prompt-harness"
            >
              <span class="truncate leading-5">
                {state().options.find((option) => option.id === state().harness)?.displayName ?? state().harness}
              </span>
              <span class="-ml-0.5 -mr-1 flex shrink-0">
                <IconV2 name="chevron-down" />
              </span>
            </MenuV2.Trigger>
            <MenuV2.Portal>
              <MenuV2.Content>
                <MenuV2.RadioGroup value={state().harness} onChange={(id: string) => void onPick(id)}>
                  <For each={state().options}>
                    {(option) => (
                      <MenuV2.RadioItem value={option.id} disabled={option.disabled} closeOnSelect>
                        {/* Live-test layout ruling: single-line entries, matching every other
                            composer select. The two-line flex-col entry fought the menu item's
                            own inline content slot (span[data-slot=menu-v2-item-content]) and
                            the texts overlapped; the disabled reason + the disclosure ride the
                            item's title tooltip instead of a second line. */}
                        <span class="truncate" title={option.disabled ? (option.reason ?? "Unavailable") : DISCLOSURE}>
                          {option.displayName}
                          <Show when={option.disabled}>
                            <span class="text-v2-text-text-faint"> — {option.reason ?? "Unavailable"}</span>
                          </Show>
                        </span>
                      </MenuV2.RadioItem>
                    )}
                  </For>
                </MenuV2.RadioGroup>
              </MenuV2.Content>
            </MenuV2.Portal>
          </MenuV2>
        </TooltipV2>
      )}
    </Show>
  )
}
