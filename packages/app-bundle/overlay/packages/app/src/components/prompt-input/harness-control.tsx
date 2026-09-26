import { For, Show, createEffect } from "solid-js"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { amicodeGet, amicodePost } from "@/utils/amicode-fetch"
import { showToast } from "@/utils/toast"
import { adoptHarnessState, liveHarnessState, parseHarnessState } from "@/components/prompt-input/harness"
import { beginHarnessSwitch } from "@/components/harness-switch-banner"

// amicode#1549 — the harness switcher in the chat box. A fourth composer
// select-slot riding the solver-mode trio: the state comes from the engine's
// GET /amicode/harness (the extension-published registry view — ONE registry,
// the same serialization the palette command renders); the write path is
// POST /amicode/harness, whose switching file the extension watcher performs.
// An unresolvable or unentitled harness renders disabled WITH its reason —
// never selectable-then-failing. No published registry (stock opencode, or
// the extension not yet booted) renders nothing at all.

/** The palette's disclosure, carried verbatim to the point of switching. */
const DISCLOSURE = "Sessions are harness-local — switching harnesses switches session history."

async function refreshHarnessState(server: ReturnType<typeof useServer>): Promise<void> {
  try {
    adoptHarnessState(parseHarnessState(await amicodeGet(server.current, "/amicode/harness")))
  } catch {
    // No answer (no extension yet, route absent) → the control stays hidden.
    adoptHarnessState(undefined)
  }
}

export function HarnessComposerControl() {
  const server = useServer()
  const sdk = useServerSDK()

  // Refetch on server change and on every (re)connect — a harness switch
  // restarts the server, so the post-restart reconnect is when the new
  // current lands here.
  createEffect(() => {
    if (server.current) void refreshHarnessState(server)
  })
  createEffect(() => {
    if (sdk().event.status() === "connected") void refreshHarnessState(server)
  })

  const onPick = async (id: string) => {
    const state = liveHarnessState()
    if (!state || id === state.harness) return
    const conn = server.current
    if (!conn) return
    try {
      const res = (await amicodePost(conn, "/amicode/harness", { harness: id })) as {
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
                        <div class="flex flex-col items-start gap-0.5 py-0.5">
                          <span class="leading-5">{option.displayName}</span>
                          <span class="max-w-[280px] text-[11px] leading-4 whitespace-normal text-v2-text-text-faint">
                            {option.disabled ? (option.reason ?? "Unavailable") : DISCLOSURE}
                          </span>
                        </div>
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
