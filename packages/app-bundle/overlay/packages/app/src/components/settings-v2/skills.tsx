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

        <Show when={!ctrl.loading()}>
          <Show when={hasProviders()}>
            <SettingsListV2>
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
            </SettingsListV2>
          </Show>

          <Show when={!hasProviders()}>
            <div style="padding:24px;text-align:center;color:var(--v2-text-text-muted);font-size:13px;border:1px dashed var(--v2-border-border-base);border-radius:var(--radius-md);">
              {language.t("settings.skills.empty")}
            </div>
          </Show>
        </Show>

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
