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
  group?: string
}

// ─── Component ──────────────────────────────────────────────────────────────

function partitionByGroup(items: PanelMenuItem[]) {
  const available = items.filter((item) => item.available())
  const ungrouped = available.filter((item) => !item.group)
  const groups = new Map<string, PanelMenuItem[]>()
  for (const item of available) {
    if (!item.group) continue
    const list = groups.get(item.group)
    if (list) list.push(item)
    else groups.set(item.group, [item])
  }
  return { ungrouped, groups }
}

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
          {(() => {
            const { ungrouped, groups } = partitionByGroup(props.items)
            return (
              <>
                <For each={ungrouped}>
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
                <For each={[...groups.entries()]}>
                  {([groupName, groupItems]) => (
                    <>
                      <div class="px-2.5 pt-2 pb-1 text-11-regular text-text-muted select-none">
                        {groupName}
                      </div>
                      <For each={groupItems}>
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
                    </>
                  )}
                </For>
              </>
            )
          })()}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}
