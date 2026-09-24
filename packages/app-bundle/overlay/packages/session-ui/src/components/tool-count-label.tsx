import { createMemo } from "solid-js"
import { AnimatedNumber } from "@opencode-ai/ui/animated-number"
import { pluralCategory, pluralKey, useI18n, type UiI18nPluralKey } from "@opencode-ai/ui/context/i18n"

// amicode#987 — the guarded split. The base renders via split(i18n.t(...)),
// but i18n.t() returns undefined while the async locale dict is still loading
// (or for a missing key), and the unguarded split(undefined) crashed the hub
// panel inside a Solid effect (one().after.startsWith(...) on undefined).
// splitCountLabel coerces falsy text to "" — an honest empty render until the
// translation exists, matching the language.tsx fallback discipline. Exported
// so the #987 guard test extracts and exercises THIS function (not a copy).
export function splitCountLabel(text?: string) {
  const value = text ?? ""
  const match = /{{\s*count\s*}}/.exec(value)
  if (!match) return { before: "", after: value }
  if (match.index === undefined) return { before: "", after: value }
  return {
    before: value.slice(0, match.index),
    after: value.slice(match.index + match[0].length),
  }
}

function common(one: string, other: string) {
  const a = Array.from(one)
  const b = Array.from(other)
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return {
    stem: a.slice(0, i).join(""),
    one: a.slice(i).join(""),
    other: b.slice(i).join(""),
  }
}

export function AnimatedCountLabel(props: { count: number; plural: UiI18nPluralKey; class?: string }) {
  const i18n = useI18n()
  const category = createMemo(() => pluralCategory(i18n.locale(), Math.round(props.count)))
  const one = createMemo(() => splitCountLabel(i18n.t(pluralKey(props.plural, "one"))))
  const other = createMemo(() => splitCountLabel(i18n.t(pluralKey(props.plural, "other"))))
  const active = createMemo(() => splitCountLabel(i18n.t(pluralKey(props.plural, category()))))
  const suffix = createMemo(() => common(one().after, other().after))
  const splitSuffix = createMemo(
    () =>
      (category() === "one" || category() === "other") &&
      one().before === other().before &&
      (one().after.startsWith(other().after) || other().after.startsWith(one().after)),
  )
  const before = createMemo(() => (splitSuffix() ? one().before : active().before))
  const stem = createMemo(() => (splitSuffix() ? suffix().stem : active().after))
  const tail = createMemo(() => {
    if (!splitSuffix()) return ""
    if (category() === "one") return suffix().one
    return suffix().other
  })
  const showTail = createMemo(() => splitSuffix() && tail().length > 0)

  return (
    <span data-component="tool-count-label" class={props.class}>
      <span data-slot="tool-count-label-before">{before()}</span>
      <AnimatedNumber value={props.count} />
      <span data-slot="tool-count-label-word">
        <span data-slot="tool-count-label-stem">{stem()}</span>
        <span data-slot="tool-count-label-suffix" data-active={showTail() ? "true" : "false"}>
          <span data-slot="tool-count-label-suffix-inner">{tail()}</span>
        </span>
      </span>
    </span>
  )
}
