// @types/vscode 1.95 does not declare `retainContextWhenHidden` on
// WebviewOptions, but the VS Code runtime honors it for webview views:
// without retention, the host suspends the view the moment the user
// switches away — the SSE stream freezes, live turns run invisible, and
// the panel shows "stuck thinking" until reload (the 2026-10-10 incident,
// fixed in sidebar_view.ts). Declaring the option here keeps the retention
// type-clean instead of casting the options object.
declare module "vscode" {
  interface WebviewOptions {
    retainContextWhenHidden?: boolean
  }
}
