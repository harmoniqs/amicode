// amicode#203: the amicode extension launches the opencode server in an
// internal scaffold directory (it only holds the injected amico config), which
// opencode registers as a project. The extension passes that dir as the
// `amicode_hide_project` boot param so the dashboard can hide it — WITHOUT
// hiding a legitimate cwd project in standalone opencode, where the param is
// never set. Read once at boot (the param is stripped from the URL after).
let hiddenProjectDir: string | undefined

/** Adopt the boot param from a URL search string (idempotent). */
export function adoptHiddenProject(search: string): void {
  const v = new URLSearchParams(search).get("amicode_hide_project")
  if (v) hiddenProjectDir = v
}

/** The worktree the dashboard should hide, or undefined (standalone / not set). */
export function hiddenProjectWorktree(): string | undefined {
  return hiddenProjectDir
}
