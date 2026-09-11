import { createMemo } from "solid-js"
import { AnimatedNumber } from "@opencode-ai/ui/animated-number"

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

export function AnimatedCountLabel(props: { count: number; one?: string; other?: string; class?: string }) {
  const one = createMemo(() => splitCountLabel(props.one))
  const other = createMemo(() => splitCountLabel(props.other))
  const singular = createMemo(() => Math.round(props.count) === 1)
  const active = createMemo(() => (singular() ? one() : other()))
  const suffix = createMemo(() => common(one().after, other().after))
  const splitSuffix = createMemo(
    () =>
      one().before === other().before &&
      (one().after.startsWith(other().after) || other().after.startsWith(one().after)),
  )
  const before = createMemo(() => (splitSuffix() ? one().before : active().before))
  const stem = createMemo(() => (splitSuffix() ? suffix().stem : active().after))
  const tail = createMemo(() => {
    if (!splitSuffix()) return ""
    if (singular()) return suffix().one
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
