import { createMemo, For, Show, type Component } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { createSkillProvidersController } from "./skills-controller"
import "./settings-v2.css"

export const SettingsSkillsV2: Component = () => {
  const language = useLanguage()
  const ctrl = createSkillProvidersController()

  const hasProviders = createMemo(() => ctrl.providers().length > 0)

  return (
    <div class="settings-v2-tab">
      <header class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.skills.title")}</h2>
        <p class="settings-v2-tab-description">{language.t("settings.skills.description")}</p>
      </header>

      <div class="settings-v2-tab-body">
        <section class="settings-v2-section">
          <div class="settings-v2-section-header" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
            <h3 class="settings-v2-section-title" style="margin:0;">{language.t("settings.skills.section.providers")}</h3>
            <div style="display:flex;gap:8px;">
              <ButtonV2 size="sm" variant="ghost" onClick={() => ctrl.autodiscover()}>
                <Icon name="search" />
                Autodiscover
              </ButtonV2>
              <ButtonV2 size="sm" variant="secondary" onClick={() => ctrl.addDirectory()}>
                <Icon name="plus" />
                {language.t("settings.skills.action.add_directory")}
              </ButtonV2>
            </div>
          </div>

          <Show when={!ctrl.loading()} fallback={<p style="color:var(--color-text-dimmed)">Loading...</p>}>
            <Show
              when={hasProviders()}
              fallback={
                <div class="settings-v2-empty-state" style="padding:24px;text-align:center;color:var(--color-text-dimmed);border:1px dashed var(--color-border);border-radius:8px;">
                  <p>{language.t("settings.skills.empty")}</p>
                </div>
              }
            >
              <div style="display:flex;flex-direction:column;gap:4px;">
                <For each={ctrl.providers()}>
                  {(provider) => (
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border:1px solid var(--color-border);border-radius:6px;background:var(--color-background-secondary);">
                      <div style="display:flex;align-items:center;gap:8px;min-width:0;">
                        <span style="font-weight:500;white-space:nowrap;">{provider.id}</span>
                        <Tag variant="neutral">
                          {provider.type === "directory" ? language.t("settings.skills.provider.type.directory") : language.t("settings.skills.provider.type.url")}
                        </Tag>
                        <span style="color:var(--color-text-dimmed);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                          {provider.path ?? provider.url ?? ""}
                        </span>
                      </div>
                      <ButtonV2
                        size="xs"
                        variant="ghost"
                        onClick={() => ctrl.removeProvider(provider.id)}
                      >
                        <Icon name="trash" />
                      </ButtonV2>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>

          {/* Autodiscover results */}
          <Show when={ctrl.discoveredPaths().length > 0}>
            <div style="margin-top:16px;padding:12px;border:1px solid var(--color-border);border-radius:8px;background:var(--color-background-secondary);">
              <p style="font-weight:500;margin:0 0 8px 0;">Discovered skill directories:</p>
              <div style="display:flex;flex-direction:column;gap:4px;">
                <For each={ctrl.discoveredPaths()}>
                  {(dirPath) => {
                    const id = dirPath.split("/").pop() ?? "skills"
                    return (
                      <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border-radius:4px;background:var(--color-background);">
                        <span style="font-size:13px;color:var(--color-text-dimmed);">{dirPath}</span>
                        <ButtonV2
                          size="xs"
                          variant="secondary"
                          onClick={() =>
                            ctrl.addProvider({
                              id,
                              type: "directory",
                              path: dirPath,
                              added: new Date().toISOString(),
                            })
                          }
                        >
                          Add
                        </ButtonV2>
                      </div>
                    )
                  }}
                </For>
              </div>
            </div>
          </Show>
        </section>
      </div>
    </div>
  )
}
