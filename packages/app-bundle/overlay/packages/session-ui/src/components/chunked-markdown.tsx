import { createMemo, For, Show } from "solid-js"
import { Markdown } from "./markdown"
import { chunkBoundaries, splitAtBoundaries } from "./chunk-boundaries"

/**
 * ChunkedMarkdown — renders settled text as multiple visual cards.
 *
 * When text contains natural boundaries (heading breaks, paragraph blocks),
 * this splits it into separate bordered cards for visual cohesion. The split
 * respects:
 * - Label heuristic: short labels (<40 chars + ":") stay with their content
 * - List coherence: consecutive lists never split
 * - Monotonicity: safe to call during streaming (boundaries only grow)
 *
 * Props:
 * - text: the full markdown text
 * - cacheKey: for Markdown component memoization
 * - streaming: whether the text is still being generated
 */
export function ChunkedMarkdown(props: { text: string; cacheKey: string; streaming: boolean }) {
  // During streaming, render as a single block (no splitting mid-stream avoids flicker)
  // On settle, compute chunk boundaries
  const chunks = createMemo(() => {
    const t = props.text
    if (!t || props.streaming) return [t]
    const boundaries = chunkBoundaries(t)
    return splitAtBoundaries(t, boundaries)
  })

  const isSingleChunk = () => chunks().length <= 1

  return (
    <Show
      when={!isSingleChunk()}
      fallback={<Markdown text={props.text} cacheKey={props.cacheKey} streaming={props.streaming} />}
    >
      <div data-slot="chunked-markdown" class="flex flex-col gap-3">
        <For each={chunks()}>
          {(chunk, index) => (
            <div
              data-slot="chunk-card"
              class="rounded-sm border border-border-weak-base px-3.5 py-3"
            >
              <Markdown text={chunk.trim()} cacheKey={`${props.cacheKey}-chunk-${index()}`} streaming={false} />
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
