import { Component, Match, Show, Switch } from "solid-js"
import { Switch as ToggleSwitch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useLanguage } from "@/context/language"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { inAmicode } from "@/utils/amicode-bridge"
import {
  createDeveloperToolsController,
  type DeveloperToolsController,
} from "./developer-tools-controller"

/** Status indicator shown below the section title during/after rebuilds. */
const RebuildStatusIndicator: Component<{ controller: DeveloperToolsController }> = (props) => {
  const language = useLanguage()
  return (
    <Switch>
      <Match when={props.controller.rebuildState() === "rebuilding"}>
        <div class="devtools-rebuild-status devtools-rebuild-status--building">
          <span class="devtools-status-dot devtools-status-dot--orange" />
          <span>{language.t("settings.general.row.devTools.rebuilding")}</span>
        </div>
      </Match>
      <Match when={props.controller.rebuildState() === "rebuilt"}>
        <div class="devtools-rebuild-status devtools-rebuild-status--done">
          <span class="devtools-status-dot devtools-status-dot--green" />
          <span>{language.t("settings.general.row.devTools.rebuilt")}</span>
        </div>
      </Match>
      <Match when={props.controller.rebuildState() === "failed"}>
        <div class="devtools-rebuild-status devtools-rebuild-status--failed">
          <span class="devtools-status-dot devtools-status-dot--red" />
          <span>{props.controller.rebuildError() ?? "Build failed"}</span>
        </div>
      </Match>
    </Switch>
  )
}

const DeveloperToolsContent: Component<{ controller: DeveloperToolsController }> = (props) => {
  const language = useLanguage()
  const opencodeError = () => {
    const s = props.controller.status()
    if (!s || s.opencodeValid) return undefined
    return s.opencodeError ?? language.t("settings.general.row.opencodePath.error.notFound")
  }
  const amicodeError = () => {
    const s = props.controller.status()
    if (!s || s.amicodeValid) return undefined
    if (s.buildError) return s.buildError
    return s.amicodeError ?? language.t("settings.general.row.amicodePath.error.notFound")
  }
  const building = () => props.controller.status()?.building ?? false
  const reloadNeeded = () => props.controller.status()?.reloadNeeded ?? false
  const isRebuilding = () => props.controller.rebuildState() === "rebuilding"

  return (
    <SettingsListV2>
      {/* Action buttons row — at the top for discoverability */}
      <Show when={props.controller.enabled()}>
        <div class="devtools-rebuild-row">
          <ButtonV2
            size="small"
            variant="neutral"
            onClick={() => props.controller.rebuild("local")}
            disabled={isRebuilding()}
          >
            {language.t("settings.general.row.devTools.rebuildLocally")}
          </ButtonV2>
          <ButtonV2
            size="small"
            variant="neutral"
            onClick={() => props.controller.rebuild("remote")}
            disabled={isRebuilding()}
          >
            {language.t("settings.general.row.devTools.rebuildRemotely")}
          </ButtonV2>
        </div>
      </Show>
      <Show when={props.controller.devcontainerMode()}>
        <div class="devtools-rebuild-row">
          <ButtonV2
            size="small"
            variant="neutral"
            onClick={() => props.controller.buildVsix()}
            disabled={props.controller.vsixBuildState() === "rebuilding"}
          >
            {props.controller.vsixBuildState() === "rebuilding" ? "Building VSIX..." : "Build VSIX"}
          </ButtonV2>
        </div>
        <Show when={props.controller.vsixBuildState() === "rebuilt"}>
          <div class="devtools-rebuild-status devtools-rebuild-status--done">
            <span class="devtools-status-dot devtools-status-dot--green" />
            <span>VSIX built: {props.controller.vsixPath() ?? ""}</span>
          </div>
        </Show>
        <Show when={props.controller.vsixBuildState() === "failed"}>
          <div class="devtools-rebuild-status devtools-rebuild-status--failed">
            <span class="devtools-status-dot devtools-status-dot--red" />
            <span>{props.controller.vsixBuildError()}</span>
          </div>
        </Show>
      </Show>

      {/* Toggle 1: Developer mode (hot-reload, eager actions) */}
      <SettingsRowV2
        title={language.t("settings.general.row.developerMode.title")}
        description={language.t("settings.general.row.developerMode.description")}
      >
        <div data-action="settings-developer-mode">
          <ToggleSwitch
            checked={props.controller.enabled()}
            onChange={(checked) => props.controller.setEnabled(checked)}
          />
        </div>
      </SettingsRowV2>

      {/* Toggle 2: Devcontainer mode (vsix build, no eager actions) — independent */}
      <SettingsRowV2
        title="Devcontainer mode (experimental)"
        description="Build a .vsix for manual installation instead of hot-reloading"
      >
        <ToggleSwitch
          checked={props.controller.devcontainerMode()}
          onChange={(checked) => props.controller.setDevcontainerMode(checked)}
        />
      </SettingsRowV2>

      {/* Path inputs — visible when EITHER mode is ON */}
      <Show when={props.controller.enabled() || props.controller.devcontainerMode()}>
        <SettingsRowV2
          title={language.t("settings.general.row.opencodePath.title")}
          description={
            <>
              {language.t("settings.general.row.opencodePath.description")}
              <Show when={opencodeError()}>
                <span class="settings-v2-field-error">{opencodeError()}</span>
              </Show>
            </>
          }
        >
          <div class="w-full sm:w-[280px]">
            <TextInputV2
              data-action="settings-opencode-path"
              type="text"
              appearance="base"
              value={props.controller.opencodePath()}
              onInput={(event) => props.controller.setOpencodePath(event.currentTarget.value)}
              onBlur={() => props.controller.commitOpencodePath()}
              placeholder={language.t("settings.general.row.opencodePath.placeholder")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label={language.t("settings.general.row.opencodePath.title")}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.amicodePath.title")}
          description={
            <>
              {language.t("settings.general.row.amicodePath.description")}
              <Show when={building()}>
                <span class="settings-v2-field-info">
                  {language.t("settings.general.row.amicodePath.building")}
                </span>
              </Show>
              <Show when={amicodeError()}>
                <span class="settings-v2-field-error">{amicodeError()}</span>
              </Show>
              <Show when={reloadNeeded()}>
                <span class="settings-v2-field-warning">
                  {language.t("settings.general.row.amicodePath.reloadNeeded")}
                </span>
              </Show>
            </>
          }
        >
          <div class="w-full sm:w-[280px]">
            <TextInputV2
              data-action="settings-amicode-path"
              type="text"
              appearance="base"
              value={props.controller.amicodePath()}
              onInput={(event) => props.controller.setAmicodePath(event.currentTarget.value)}
              onBlur={() => props.controller.commitAmicodePath()}
              placeholder={language.t("settings.general.row.amicodePath.placeholder")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label={language.t("settings.general.row.amicodePath.title")}
            />
          </div>
        </SettingsRowV2>
      </Show>

      {/* VSIX output path — only when devcontainer mode is ON */}
      <Show when={props.controller.devcontainerMode()}>
        <SettingsRowV2
          title="VSIX output path"
          description="Directory where the built .vsix is emitted"
        >
          <div class="w-full sm:w-[280px]">
            <TextInputV2
              type="text"
              appearance="base"
              value={props.controller.vsixOutputPath()}
              onInput={(e) => props.controller.setVsixOutputPath(e.currentTarget.value)}
              placeholder="/workspaces/artifacts/"
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label="VSIX output path"
            />
          </div>
        </SettingsRowV2>
      </Show>
    </SettingsListV2>
  )
}

export const DeveloperToolsSection: Component = () => {
  const language = useLanguage()
  const controller = createDeveloperToolsController()

  return (
    <div id="settings-developer-tools" class="settings-v2-section">
      <div class="devtools-section-header">
        <h3 class="settings-v2-section-title">
          {language.t("settings.general.section.developerTools")}
        </h3>
        <RebuildStatusIndicator controller={controller} />
      </div>
      <DeveloperToolsContent controller={controller} />

      <Show when={inAmicode()}>
        <SettingsListV2>
          <SettingsRowV2
            title="Redo Onboarding"
            description="Reset onboarding state and re-run the setup flow. Your model config is preserved."
          >
            <ButtonV2
              size="small"
              variant="neutral"
              onClick={() => {
                window.parent.postMessage(
                  { source: "amicode", kind: "redo-onboarding" },
                  "*",
                )
              }}
            >
              Redo Onboarding
            </ButtonV2>
          </SettingsRowV2>
        </SettingsListV2>
      </Show>
    </div>
  )
}
