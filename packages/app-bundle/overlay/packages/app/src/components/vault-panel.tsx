// amicode: the standalone Vault drawer — the vault's ONLY host, on EVERY
// route (home, new-session, session; amicode#105, ADR docs/adr/0001). The
// side-panel tab it used to yield to inside sessions is retired: two hosts
// mirrored through two stores was the desync the titlebar button got blamed
// for. Renders the same VaultBrowser body everywhere.
import { Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { vaultPanel } from "@/context/vault-panel"
import { VaultBrowser } from "@/components/vault-browser"

export function VaultPanel() {
  const language = useLanguage()
  return (
    <Show when={vaultPanel.opened()}>
      <aside
        data-component="amico-vault-panel"
        aria-label={language.t("amicode.vault.title")}
        class="fixed bottom-2 left-18 top-12 z-40 flex w-[360px] max-w-[85vw] flex-col overflow-hidden rounded-xl border border-border-weaker-base bg-background-base shadow-[var(--v2-elevation-raised)]"
      >
        <VaultBrowser onClose={() => vaultPanel.close()} />
      </aside>
    </Show>
  )
}
