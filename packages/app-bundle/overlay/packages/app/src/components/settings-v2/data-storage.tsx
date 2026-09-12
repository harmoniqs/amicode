import { Component, Show } from "solid-js"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useLanguage } from "@/context/language"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { createDataStorageController, type DataStorageController } from "./data-storage-controller"

const DataStorageContent: Component<{ controller: DataStorageController }> = (props) => {
  const language = useLanguage()

  const databaseError = () => {
    const s = props.controller.status()
    if (!s || s.databaseValid) return undefined
    return s.databaseError ?? language.t("settings.general.row.dataStorage.database.error.invalidPath")
  }

  const configError = () => {
    const s = props.controller.status()
    if (!s || s.configValid) return undefined
    return s.configError ?? language.t("settings.general.row.dataStorage.configDir.error.invalidPath")
  }

  return (
    <SettingsListV2>
      <SettingsRowV2
        title={language.t("settings.general.row.dataStorage.database.title")}
        description={
          <>
            {language.t("settings.general.row.dataStorage.database.description")}
            <Show when={databaseError()}>
              <span class="settings-v2-field-error">{databaseError()}</span>
            </Show>
          </>
        }
      >
        <div class="w-full sm:w-[280px]">
          <TextInputV2
            data-action="settings-data-storage-database"
            type="text"
            appearance="base"
            value={props.controller.databasePath()}
            onInput={(event) => props.controller.setDatabasePath(event.currentTarget.value)}
            onBlur={() => props.controller.commitDatabasePath()}
            placeholder={props.controller.defaults()?.databasePath ?? ""}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
            aria-label={language.t("settings.general.row.dataStorage.database.title")}
          />
        </div>
      </SettingsRowV2>

      <SettingsRowV2
        title={language.t("settings.general.row.dataStorage.configDir.title")}
        description={
          <>
            {language.t("settings.general.row.dataStorage.configDir.description")}
            <Show when={configError()}>
              <span class="settings-v2-field-error">{configError()}</span>
            </Show>
          </>
        }
      >
        <div class="w-full sm:w-[280px]">
          <TextInputV2
            data-action="settings-data-storage-config-dir"
            type="text"
            appearance="base"
            value={props.controller.configDir()}
            onInput={(event) => props.controller.setConfigDir(event.currentTarget.value)}
            onBlur={() => props.controller.commitConfigDir()}
            placeholder={props.controller.defaults()?.configDir ?? ""}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
            aria-label={language.t("settings.general.row.dataStorage.configDir.title")}
          />
        </div>
      </SettingsRowV2>
    </SettingsListV2>
  )
}

export const DataStorageSection: Component = () => {
  const language = useLanguage()
  const controller = createDataStorageController()

  return (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">
        {language.t("settings.general.section.dataStorage")}
      </h3>
      <DataStorageContent controller={controller} />
    </div>
  )
}
