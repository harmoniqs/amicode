import { For, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PanelMenuItem {
  id: string
  label: string
  icon: string
  available: () => boolean
  active?: () => boolean
}

// ─── Component ──────────────────────────────────────────────────────────────

export function PanelMenu(props: {
  items: PanelMenuItem[]
  onSelect: (id: string) => void
  v2?: boolean
}) {
  return (
    <DropdownMenu gutter={4} placement="bottom-end">
      <DropdownMenu.Trigger
        class="flex items-center justify-center w-7 h-7 rounded-md text-text-weak hover:text-text-base hover:bg-background-stronger transition-colors cursor-pointer"
        aria-label="Open panel"
      >
        <Icon name="plus-small" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          class="z-50 min-w-[160px] overflow-hidden rounded-lg border border-border-base bg-background-base p-1 shadow-md"
        >
          <For each={props.items.filter((item) => item.available())}>
            {(item) => (
              <DropdownMenu.Item
                class="flex items-center gap-2 px-2.5 py-1.5 rounded-md text-12-regular text-text-base cursor-pointer outline-none hover:bg-background-stronger focus:bg-background-stronger transition-colors"
                classList={{
                  "opacity-60": item.active?.() ?? false,
                }}
                onSelect={() => props.onSelect(item.id)}
              >
                <Icon name={item.icon as any} size="small" class="text-text-weak" />
                <span>{item.label}</span>
                <Show when={item.active?.()}>
                  <Icon name="check-small" size="small" class="ml-auto text-text-weak" />
                </Show>
              </DropdownMenu.Item>
            )}
          </For>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}
