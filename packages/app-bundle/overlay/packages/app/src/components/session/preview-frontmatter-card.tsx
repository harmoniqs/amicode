// AMICODE: the Preview tab's front-matter card. Replaces marked's rendering
// of a YAML block (a rule + one giant <h2> of every key) with:
//   - a header line: type · status (activity-coloured dot) · date · confidence
//   - tags as chips
//   - a collapsible "Properties" grid for everything else (empty values hidden,
//     [[wikilinks]] and paths openable)
// Unparseable front matter shows verbatim in a quiet code block.
import { createMemo, createSignal, For, Show } from "solid-js"
import { openFileInEditor } from "@opencode-ai/ui/amicode-bridge"
import { resolveFileRefCached } from "@opencode-ai/session-ui/markdown-file-refs"
import {
  HEADER_KEYS,
  isPresent,
  wikilink,
  type Frontmatter,
  type FrontmatterEntry,
  type FrontmatterValue,
} from "./preview-frontmatter"

const STATUS_ACTIVITY: Record<string, string> = {
  running: "running",
  active: "running",
  "in-progress": "running",
  in_progress: "running",
  pending: "attention",
  stalled: "attention",
  blocked: "attention",
  draft: "attention",
  review: "attention",
  complete: "success",
  completed: "success",
  done: "success",
  passed: "success",
  merged: "success",
  failed: "error",
  error: "error",
  dead: "error",
  aborted: "idle",
  superseded: "idle",
  archived: "idle",
}

function statusColor(value: string): string {
  const activity = STATUS_ACTIVITY[value.trim().toLowerCase().split(/[\s(;:,]/)[0] ?? ""] ?? "idle"
  return `var(--activity-${activity})`
}

function text(value: FrontmatterValue): string {
  if (Array.isArray(value)) return value.map(text).join(", ")
  return value === null ? "" : String(value)
}

function looksLikePath(value: string) {
  return /^(~?\/|\.\.?\/)[^\s]+$/.test(value) || /^[\w.-]+\/[\w./-]+\.\w{1,6}$/.test(value)
}

function looksLikeHash(value: string) {
  return /^[0-9a-f]{7,64}$/i.test(value)
}

async function openRef(ref: string) {
  const abs = await resolveFileRefCached(ref)
  if (abs) openFileInEditor(abs)
}

function ValueChip(props: { value: string }) {
  const link = createMemo(() => wikilink(props.value))
  const [missing, setMissing] = createSignal(false)
  return (
    <Show
      when={link()}
      fallback={
        <Show
          when={looksLikePath(props.value)}
          fallback={
            <span class={looksLikeHash(props.value) ? "font-mono" : undefined} title={props.value}>
              {looksLikeHash(props.value) && props.value.length > 12 ? props.value.slice(0, 12) + "…" : props.value}
            </span>
          }
        >
          <button
            type="button"
            data-slot="fm-link"
            class="font-mono"
            title={props.value}
            onClick={() => void openRef(props.value)}
          >
            {props.value}
          </button>
        </Show>
      }
    >
      {(l) => (
        <button
          type="button"
          data-slot="fm-link"
          data-missing={missing() ? "true" : undefined}
          title={missing() ? `${l().target} — not found` : l().target}
          onClick={async () => {
            const abs = (await resolveFileRefCached(`${l().target}.md`)) ?? (await resolveFileRefCached(l().target))
            if (abs) openFileInEditor(abs)
            else setMissing(true)
          }}
        >
          {l().label}
        </button>
      )}
    </Show>
  )
}

function Value(props: { value: FrontmatterValue }) {
  return (
    <Show
      when={Array.isArray(props.value)}
      fallback={
        <Show when={typeof props.value === "boolean"} fallback={<ValueChip value={text(props.value)} />}>
          <span>{props.value ? "yes" : "no"}</span>
        </Show>
      }
    >
      <span data-slot="fm-list">
        <For each={(props.value as FrontmatterValue[]).filter(isPresent)}>
          {(item) => (
            <span data-slot="fm-list-item">
              <ValueChip value={text(item)} />
            </span>
          )}
        </For>
      </span>
    </Show>
  )
}

export function FrontmatterCard(props: { frontmatter: Frontmatter }) {
  const [open, setOpen] = createSignal(false)
  const parsed = () => (props.frontmatter.kind === "parsed" ? props.frontmatter.entries : undefined)
  const get = (key: string) => parsed()?.find((entry) => entry.key === key)
  const header = createMemo(() =>
    HEADER_KEYS.map((key) => get(key)).filter((entry): entry is FrontmatterEntry => !!entry && isPresent(entry.value)),
  )
  const tags = createMemo(() => {
    const value = get("tags")?.value
    const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\s]+/) : []
    return list.map(text).filter((tag) => tag !== "")
  })
  const rest = createMemo(() =>
    (parsed() ?? []).filter(
      (entry) => entry.key !== "tags" && !(HEADER_KEYS as readonly string[]).includes(entry.key) && isPresent(entry.value),
    ),
  )
  const hidden = createMemo(() => (parsed() ?? []).filter((entry) => !isPresent(entry.value)).length)

  return (
    <section data-component="preview-frontmatter" aria-label="Document properties">
      <Show
        when={parsed()}
        fallback={
          <details data-slot="fm-raw">
            <summary>Front matter</summary>
            <pre>{props.frontmatter.raw}</pre>
          </details>
        }
      >
        <Show when={header().length > 0}>
          <div data-slot="fm-header">
            <For each={header()}>
              {(entry) => (
                <span data-slot="fm-header-item" data-key={entry.key}>
                  <Show when={entry.key === "status"}>
                    <span
                      data-slot="fm-status-dot"
                      aria-hidden="true"
                      style={{ background: statusColor(text(entry.value)) }}
                    />
                  </Show>
                  <Show when={entry.key === "confidence"}>
                    <span data-slot="fm-header-key">confidence</span>
                  </Show>
                  <span data-slot="fm-header-value" title={text(entry.value)}>
                    {text(entry.value)}
                  </span>
                </span>
              )}
            </For>
          </div>
        </Show>
        <Show when={tags().length > 0}>
          <div data-slot="fm-tags">
            <For each={tags()}>{(tag) => <span data-slot="fm-tag">{tag}</span>}</For>
          </div>
        </Show>
        <Show when={rest().length > 0}>
          <button
            type="button"
            data-slot="fm-toggle"
            aria-expanded={open()}
            onClick={() => setOpen((value) => !value)}
          >
            <span data-slot="fm-chevron" data-open={open() ? "true" : "false"} aria-hidden="true" />
            {open() ? "Hide properties" : `${rest().length} ${rest().length === 1 ? "property" : "properties"}`}
            <Show when={hidden() > 0}>
              <span data-slot="fm-muted"> · {hidden()} empty</span>
            </Show>
          </button>
          <Show when={open()}>
            <dl data-slot="fm-grid">
              <For each={rest()}>
                {(entry) => (
                  <>
                    <dt>{entry.key.replace(/_/g, " ")}</dt>
                    <dd>
                      <Value value={entry.value} />
                    </dd>
                  </>
                )}
              </For>
            </dl>
          </Show>
        </Show>
      </Show>
    </section>
  )
}
