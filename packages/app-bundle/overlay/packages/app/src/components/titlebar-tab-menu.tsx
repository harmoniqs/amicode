// amicode(#2154): the session tab right-click menu, shared by session and
// draft tabs. The strip computes the model (what each bulk close would close)
// lazily — the menu content only renders while the menu is open.
import { Show } from "solid-js"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { useLanguage } from "@/context/language"

export type TabMenu = {
  /** present only for tabs that can be pinned (session tabs) */
  pinned?: boolean
  onTogglePin?: () => void
  /** how many tabs each bulk close would close; 0 disables the item */
  closeOthers: number
  closeRight: number
  closeFinished: number
  /** size of the spawned-session group the tab is in; 0 hides the item */
  group: number
  onCloseOthers: () => void
  onCloseRight: () => void
  onCloseFinished: () => void
  onCloseGroup: () => void
}

const counted = (label: string, count: number) => (count > 0 ? `${label} (${count})` : label)

export function TabMenuItems(props: {
  menu: TabMenu
  onRename?: () => void
  renameDisabled?: boolean
  onClose: () => void
}) {
  const language = useLanguage()
  return (
    <>
      <Show when={props.onRename}>
        {(rename) => (
          <MenuV2.Item disabled={props.renameDisabled} onSelect={rename()}>
            {language.t("common.rename")}
          </MenuV2.Item>
        )}
      </Show>
      <Show when={props.menu.onTogglePin}>
        {(toggle) => (
          <MenuV2.Item onSelect={toggle()}>{props.menu.pinned ? "Unpin tab" : "Pin tab"}</MenuV2.Item>
        )}
      </Show>
      <MenuV2.Separator />
      <MenuV2.Item onSelect={props.onClose}>{language.t("common.closeTab")}</MenuV2.Item>
      <MenuV2.Item disabled={props.menu.closeOthers === 0} onSelect={props.menu.onCloseOthers}>
        {counted("Close other tabs", props.menu.closeOthers)}
      </MenuV2.Item>
      <MenuV2.Item disabled={props.menu.closeRight === 0} onSelect={props.menu.onCloseRight}>
        {counted("Close tabs to the right", props.menu.closeRight)}
      </MenuV2.Item>
      <MenuV2.Item disabled={props.menu.closeFinished === 0} onSelect={props.menu.onCloseFinished}>
        {counted("Close finished tabs", props.menu.closeFinished)}
      </MenuV2.Item>
      <Show when={props.menu.group > 0}>
        <MenuV2.Item onSelect={props.menu.onCloseGroup}>{counted("Close group", props.menu.group)}</MenuV2.Item>
      </Show>
    </>
  )
}
