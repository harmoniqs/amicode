import { createMemo, For, Show, type Component } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
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
        <p class="settings-v2-tab-description" style="margin-top:8px;font-size:13px;color:var(--v2-text-text-muted);">
          {language.t("settings.skills.description")}
        </p>
      </header>

      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.skills.section.providers")}</h3>
          <SettingsListV2>
            <Show when={!ctrl.loading()} fallback={
              <div data-component="settings-v2-row" style="justify-content:center;">
                <span style="color:var(--v2-text-text-muted);font-size:13px;">Loading...</span>
              </div>
            }>
              <Show
                when={hasProviders()}
                fallback={
                  <div data-component="settings-v2-row" style="justify-content:center;">
                    <span style="color:var(--v2-text-text-muted);font-size:13px;">
                      {language.t("settings.skills.empty")}
                    </span>
                  </div>
                }
              >
                <For each={ctrl.providers()}>
                  {(provider) => (
                    <SettingsRowV2
                      title={
                        <span style="display:flex;align-items:center;gap:8px;">
                          {provider.id}
                          <Tag variant="neutral">
                            {provider.type === "directory"
                              ? language.t("settings.skills.provider.type.directory")
                              : language.t("settings.skills.provider.type.url")}
                          </Tag>
                        </span>
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

          <div style="display:flex;gap:8px;margin-top:12px;">
            <ButtonV2 size="sm" variant="secondary" onClick={() => ctrl.addDirectory()}>
              <Icon name="plus" />
              {language.t("settings.skills.action.add_directory")}
            </ButtonV2>
            <ButtonV2 size="sm" variant="secondary" onClick={() => ctrl.autodiscover()}>
              <Icon name="magnifying-glass" />
              Autodiscover
            </ButtonV2>
          </div>
        </div>

        {/* Autodiscover results */}
        <Show when={ctrl.discoveredPaths().length > 0}>
          <div class="settings-v2-section">
            <h3 class="settings-v2-section-title">Discovered</h3>
            <SettingsListV2>
              <For each={ctrl.discoveredPaths()}>
                {(dirPath) => {
                  const id = dirPath.split("/").pop() ?? "skills"
                  return (
                    <SettingsRowV2
                      title={id}
                      description={dirPath}
                    >
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
                    </SettingsRowV2>
                  )
                }}
              </For>
            </SettingsListV2>
          </div>
        </Show>
      </div>
    </div>
  )
}
