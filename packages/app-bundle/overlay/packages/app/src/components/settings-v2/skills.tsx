import { createMemo, createSignal, For, Show, type Component } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import "./settings-v2.css"

interface SkillProvider {
  id: string
  type: "directory" | "url"
  path?: string
  url?: string
  added: string
}

interface SkillEntry {
  name: string
  description: string
  source: "custom" | "workspace" | "library" | "package"
}

export const SettingsSkillsV2: Component = () => {
  const language = useLanguage()

  // TODO: Wire to actual providers.json via extension host bridge
  const [providers, setProviders] = createSignal<SkillProvider[]>([])
  const [expandedProvider, setExpandedProvider] = createSignal<string | null>(null)

  const toggleExpand = (id: string) => {
    setExpandedProvider((prev) => (prev === id ? null : id))
  }

  return (
    <div class="settings-v2-tab">
      <header class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.skills.title")}</h2>
        <p class="settings-v2-tab-description">{language.t("settings.skills.description")}</p>
      </header>

      <div class="settings-v2-tab-body">
        <section class="settings-v2-section">
          <div class="settings-v2-section-header">
            <h3 class="settings-v2-section-title">{language.t("settings.skills.section.providers")}</h3>
            <ButtonV2 size="sm" variant="secondary" onClick={() => {/* TODO: file picker */}}>
              <Icon name="plus" />
              {language.t("settings.skills.action.add_directory")}
            </ButtonV2>
          </div>

          <Show
            when={providers().length > 0}
            fallback={
              <div class="settings-v2-empty-state">
                <p>{language.t("settings.skills.empty")}</p>
              </div>
            }
          >
            <div class="settings-v2-list">
              <For each={providers()}>
                {(provider) => (
                  <div class="settings-v2-list-item">
                    <div
                      class="settings-v2-list-item-header"
                      onClick={() => toggleExpand(provider.id)}
                    >
                      <div class="settings-v2-list-item-info">
                        <Icon name={expandedProvider() === provider.id ? "chevron-down" : "chevron-right"} />
                        <span class="settings-v2-list-item-title">{provider.id}</span>
                        <Tag variant="neutral">
                          {language.t(`settings.skills.provider.type.${provider.type}`)}
                        </Tag>
                      </div>
                      <div class="settings-v2-list-item-actions">
                        <span class="settings-v2-list-item-path">
                          {provider.path ?? provider.url ?? ""}
                        </span>
                        <ButtonV2
                          size="xs"
                          variant="ghost"
                          onClick={(e) => {
                            e.stopPropagation()
                            setProviders((prev) => prev.filter((p) => p.id !== provider.id))
                          }}
                        >
                          <Icon name="trash" />
                        </ButtonV2>
                      </div>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </section>
      </div>
    </div>
  )
}
