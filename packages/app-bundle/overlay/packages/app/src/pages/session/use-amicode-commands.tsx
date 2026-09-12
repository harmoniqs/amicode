import { useCommand, type CommandOption } from "@/context/command"
import { inAmicode, postAmicode } from "@/utils/amicode-bridge"

// amicode: ops commands bridged to the VS Code extension host. Registered on BOTH
// the session and the new-session (draft) pages so they work everywhere inside
// Amicode — the draft page has no command palette (DialogSelectFile needs session
// context), so restart/update-memory carry direct keybinds, which the global
// command keydown handler fires with no dialog. The rest stay palette-discoverable
// inside a session. Shown only when framed. en-only by design.
//
// Each command posts {source:"amicode",kind:"command",command} to window.parent;
// chat_panel.ts relays it to an ALLOWLISTED vscode command.

// The bridge helpers live in @/utils/amicode-bridge (extracted so surfaces like
// the report-a-bug button can post without this registry); re-exported here for
// the existing importers (pulse chip, prompt inputs) and their contract test.
export { inAmicode, postAmicode }

export function useAmicodeCommands() {
  const command = useCommand()
  const amico = (option: Omit<CommandOption, "category">): CommandOption => ({ ...option, category: "Amico" })

  // Not gated on inAmicode: the Vault panel talks straight to the server's
  // /amicode/vault-* routes, so it works in any host.
  command.register("amicode-vault", () => [
    amico({
      id: "vault.toggle",
      title: "Toggle vault panel",
      description: "Browse the attached vault mounts and read notes inline",
      onSelect: () => {
        void import("@/context/vault-panel").then((m) => m.vaultPanel.toggle())
      },
    }),
  ])

  command.register("amicode", () =>
    inAmicode()
      ? [
          amico({
            id: "amicode.restartServer",
            title: "Restart Amico server",
            description: "Relaunch the opencode server — picks up a rebuilt binary",
            keybind: "mod+alt+r",
            onSelect: () => postAmicode("amicode.restartServer"),
          }),
          amico({
            id: "amicode.distillNow",
            title: "Update my memory now",
            description: "Run the background distiller over recent work",
            keybind: "mod+alt+m",
            onSelect: () => postAmicode("amicode.distillNow"),
          }),
          amico({
            id: "amicode.stopRun",
            title: "Stop current solve",
            onSelect: () => postAmicode("amicode.stopRun"),
          }),
          amico({
            id: "amicode.savePulse",
            title: "Save pulse from current run",
            onSelect: () => postAmicode("amicode.savePulse"),
          }),
          amico({
            id: "amicode.openRunDir",
            title: "Open current run directory",
            onSelect: () => postAmicode("amicode.openRunDir"),
          }),
          amico({
            id: "amicode.openInspector",
            title: "Open pulse inspector",
            onSelect: () => postAmicode("amicode.openInspector"),
          }),
        ]
      : [],
  )
}
