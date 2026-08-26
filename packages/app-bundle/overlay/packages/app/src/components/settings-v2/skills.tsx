import { createMemo, createSignal, For, Show, type Component } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useLanguage } from "@/context/language"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { createSkillProvidersController } from "./skills-controller"
import "./settings-v2.css"

export const SettingsSkillsV2: Component = () => {
  const language = useLanguage()
  const ctrl = createSkillProvidersController()

  const hasProviders = createMemo(() => ctrl.providers().length > 0)
  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [editValue, setEditValue] = createSignal("")

  const startEditing = (id: string) => {
    setEditingId(id)
    setEditValue(id)
  }

  const commitRename = () => {
    const oldId = editingId()
    const newId = editValue().trim()
    if (oldId && newId && newId !== oldId) {
      ctrl.renameProvider(oldId, newId)
    }
    setEditingId(null)
  }

  const cancelEditing = () => {
    setEditingId(null)
  }

  return (
    <div class="settings-v2-tab">
      <header class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.skills.title")}</h2>
        <p style="margin-top:8px;font-size:13px;color:var(--v2-text-text-muted);">
          {language.t("settings.skills.description")}
        </p>
      </header>

      <div class="settings-v2-tab-body">
        <div style="display:flex;gap:8px;">
          <ButtonV2 size="sm" variant="secondary" onClick={() => ctrl.addDirectory()}>
            <Icon name="plus" />
            {language.t("settings.skills.action.add_directory")}
          </ButtonV2>
          <ButtonV2 size="sm" variant="secondary" onClick={() => ctrl.autodiscover()}>
            <Icon name="magnifying-glass" />
            Autodiscover
          </ButtonV2>
        </div>

        <SettingsListV2>
          <Show when={!ctrl.loading()} fallback={
            <div style="padding:20px;text-align:center;color:var(--v2-text-text-muted);font-size:13px;">
              Loading...
            </div>
          }>
            <Show
              when={hasProviders()}
              fallback={
                <div style="padding:20px;text-align:center;color:var(--v2-text-text-muted);font-size:13px;">
                  {language.t("settings.skills.empty")}
                </div>
              }
            >
              <For each={ctrl.providers()}>
                {(provider) => (
                  <SettingsRowV2
                    title={
                      <Show
                        when={editingId() === provider.id}
                        fallback={
                          <span
                            style="display:flex;align-items:center;gap:8px;cursor:default;"
                            onDblClick={() => startEditing(provider.id)}
                            title="Double-click to rename"
                          >
                            {provider.id}
                            <Tag variant="neutral">
                              {provider.type === "directory"
                                ? language.t("settings.skills.provider.type.directory")
                                : language.t("settings.skills.provider.type.url")}
                            </Tag>
                          </span>
                        }
                      >
                        <div
                          style="display:flex;align-items:center;gap:8px;width:220px;"
                          on:keydown={(e: KeyboardEvent) => {
                            if (e.key === "Enter") { e.preventDefault(); commitRename() }
                            if (e.key === "Escape") { e.preventDefault(); cancelEditing() }
                          }}
                        >
                          <TextInputV2
                            type="text"
                            appearance="base"
                            value={editValue()}
                            onInput={(e) => setEditValue(e.currentTarget.value)}
                            onBlur={() => commitRename()}
                            autofocus
                            aria-label="Rename provider"
                          />
                        </div>
                      </Show>
                    }
                    description={provider.path ?? provider.url ?? ""}
                  >
                    <ButtonV2
                      size="xs"
                      variant="ghost"
                      onClick={() => ctrl.removeProvider(provider.id)}
                      aria-label={`Remove ${provider.id}`}
                    >
                      <Icon name="trash" />
                    </ButtonV2>
                  </SettingsRowV2>
                )}
              </For>
            </Show>
          </Show>
        </SettingsListV2>

        {/* Autodiscover results */}
        <Show when={ctrl.discoveredPaths().length > 0}>
          <div class="settings-v2-section">
            <h3 class="settings-v2-section-title">Discovered</h3>
            <SettingsListV2>
              <For each={ctrl.discoveredPaths()}>
                {(item) => (
                  <SettingsRowV2
                    title={item.name}
                    description={item.path}
                  >
                    <ButtonV2
                      size="xs"
                      variant="secondary"
                      onClick={() =>
                        ctrl.addProvider({
                          id: item.name,
                          type: "directory",
                          path: item.path,
                          added: new Date().toISOString(),
                        })
                      }
                    >
                      Add
                    </ButtonV2>
                  </SettingsRowV2>
                )}
              </For>
            </SettingsListV2>
          </div>
        </Show>
      </div>
    </div>
  )
}
