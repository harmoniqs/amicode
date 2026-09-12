// AMICODE: Vaults tab body for the connections popover. Presentation only —
// the app layer owns fetching (per-active-server, Basic auth) and passes the
// parsed VaultsView down. `view === undefined` means loading.
import { For, Show } from "solid-js"
import type { VaultsView } from "./vaults"

export const AMICODE_MANAGE_VAULTS_PROMPT = "Help me manage my vaults — check status, mount, create, or repair."

export function AmicodeVaultsTab(props: {
  view: VaultsView | undefined
  emptyLabel: string
  retryLabel: string
  onRetry: () => void
}) {
  return (
    <div class="flex flex-col" data-component="amicode-vaults-tab">
      <Show
        when={props.view}
        fallback={<div class="h-8 mx-2 my-1 rounded-md bg-surface-raised-base animate-pulse" aria-hidden />}
      >
        {(view) => (
          <Show
            when={view().ok}
            fallback={
              <div class="flex items-center gap-2 w-full px-2 py-1">
                <div class="size-1.5 rounded-full shrink-0 bg-icon-critical-base" />
                <span class="text-14-regular text-text-weak flex-1 truncate">{view().error}</span>
                <button
                  type="button"
                  class="text-12-regular text-text-base underline shrink-0"
                  data-slot="amicode-vaults-retry"
                  onClick={props.onRetry}
                >
                  {props.retryLabel}
                </button>
              </div>
            }
          >
            <Show
              when={view().mounts.length > 0}
              fallback={<div class="text-14-regular text-text-base text-center my-auto py-1">{props.emptyLabel}</div>}
            >
              <For each={view().mounts}>
                {(mount) => (
                  <div class="flex flex-col w-full px-2 py-1" data-slot="amicode-vault-row">
                    <div class="flex items-center gap-2 w-full min-w-0">
                      <div
                        classList={{
                          "size-1.5 rounded-full shrink-0": true,
                          "bg-icon-success-base": mount.warnings.length === 0,
                          "bg-icon-warning-base": mount.warnings.length > 0,
                        }}
                      />
                      <span class="text-14-regular text-text-base truncate">{mount.id}</span>
                      <Show when={mount.kind}>
                        <span class="text-12-regular text-text-weak truncate">{mount.kind}</span>
                      </Show>
                      <Show when={mount.writable !== undefined}>
                        <span class="text-11-regular text-text-base bg-surface-base px-1.5 py-0.5 rounded-md shrink-0">
                          {mount.writable ? "rw" : "ro"}
                        </span>
                      </Show>
                      <div class="flex-1" />
                      <span class="text-12-regular text-text-weak shrink-0">{mount.lastSync}</span>
                    </div>
                    <Show when={mount.warnings.length > 0}>
                      <div class="pl-3.5 text-11-regular text-text-weaker truncate">
                        {mount.warnings[0]}
                        {mount.warnings.length > 1 ? ` (+${mount.warnings.length - 1} more)` : ""}
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </Show>
        )}
      </Show>
    </div>
  )
}
