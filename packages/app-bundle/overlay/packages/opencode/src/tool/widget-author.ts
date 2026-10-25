import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { authorWidget } from "@/server/amicode/widgets"
import DESCRIPTION from "./widget-author.txt"

// AMICODE (Stage 2 chat authoring): the model calls this to write/update a home
// dashboard widget from a conversation. The tool name is `amicode_author_widget`
// so the UI's name-based seam (/^amicode_/ → AmicodeToolCard) renders its result
// as a live widget preview + Pin button. The result OUTPUT carries an
// `AMICODE_WIDGET {json}` sentinel (the RunWindow/AMICODE_DIFF precedent) that the
// card parses for {id, hash} to build the preview frame src. Re-calling with the
// same id updates in place → new content hash → preview hot-reloads.

export const Parameters = Schema.Struct({
  id: Schema.String.annotate({
    description: "kebab-case widget id (also its folder name). Reuse an id to UPDATE that widget in place.",
  }),
  name: Schema.String.annotate({ description: "human title shown in the widget header / edit controls" }),
  size: Schema.Literals(["tile", "hero"]).annotate({
    description: '"tile" = compact card in the tile row; "hero" = wide card in the top grid',
  }),
  height: Schema.Number.annotate({ description: "resting pixel height (40..2000); the frame grows to content" }),
  sticky: Schema.optional(Schema.Boolean).annotate({
    description:
      "optional; true = when the card scrolls out of view on home, dock it at the top as a slim ~64px strip (the widget receives density 'tight' while docked). Use for live/streaming widgets.",
  }),
  description: Schema.optional(Schema.String).annotate({ description: "one-line description of the widget" }),
  js: Schema.String.annotate({
    description: "the widget.js ES module body: export default { mount: function (el, amico) { ... } }",
  }),
})

type Metadata = { id: string; ok: boolean; hash: string | null }

export const WidgetAuthorTool = Tool.define<typeof Parameters, Metadata, never>(
  "amicode_author_widget",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context<Metadata>) =>
        Effect.sync(() => {
          const r = authorWidget({
            id: params.id,
            name: params.name,
            size: params.size,
            height: params.height,
            sticky: params.sticky,
            description: params.description,
            js: params.js,
          })
          if (!r.ok) {
            return {
              title: `Widget rejected: ${params.id}`,
              output: `The widget was NOT written. ${r.error}. Fix the input and call amicode_author_widget again.`,
              metadata: { id: params.id, ok: false, hash: null },
            }
          }
          const sentinel = JSON.stringify({
            id: r.id,
            name: r.name,
            size: r.size,
            height: r.height,
            hash: r.hash,
            warnings: r.warnings,
          })
          const warnLine = r.warnings.length ? ` Warnings: ${r.warnings.join("; ")}.` : ""
          return {
            title: `Authored widget "${r.id}"`,
            output:
              `Authored "${r.name}" (${r.size}) ✓.${warnLine} ` +
              `A live preview is shown below — the user can Pin it to their dashboard.\n` +
              `AMICODE_WIDGET ${sentinel}`,
            metadata: { id: r.id, ok: true, hash: r.hash },
          }
        }),
    }
  }),
)
