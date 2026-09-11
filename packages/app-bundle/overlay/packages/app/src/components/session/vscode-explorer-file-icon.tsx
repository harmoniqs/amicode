import { createMemo, Show } from "solid-js"
import {
  explorerIconAssetUrl,
  explorerIconFontFamily,
  explorerIconTheme,
  resolveExplorerFileIcon,
} from "@/utils/vscode-explorer-icon-theme"

export function decodeExplorerGlyph(glyph: string): string {
  return glyph.replace(/\\([0-9a-f]{1,6})\s?/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
}

/** Decorative file icon sourced from VS Code's currently active Explorer theme. */
export function ExplorerFileIcon(props: { path: string }) {
  const icon = createMemo(() => resolveExplorerFileIcon(props.path))
  return (
    <Show when={icon()}>
      {(value) => {
        const current = value()
        if (current.kind === "svg") {
          return (
            <img
              data-component="vscode-explorer-file-icon"
              class="size-4 shrink-0"
              src={explorerIconAssetUrl(current.asset)}
              alt=""
              aria-hidden="true"
            />
          )
        }
        return (
          <span
            data-component="vscode-explorer-file-icon"
            class="size-4 shrink-0 inline-flex items-center justify-center leading-none"
            aria-hidden="true"
            style={{
              "font-family": explorerIconFontFamily,
              "font-size": explorerIconTheme().font?.size ?? "100%",
              color: current.color ?? "currentColor",
            }}
          >
            {decodeExplorerGlyph(current.glyph)}
          </span>
        )
      }}
    </Show>
  )
}
