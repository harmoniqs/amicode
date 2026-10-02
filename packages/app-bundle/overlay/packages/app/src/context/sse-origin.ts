// SSE FAN-IN ORIGIN DETECTION (#1539) — pure logic for determining whether an
// SSE event originated from the local engine or a remote peer, by diffing the
// composite cursor `id:` field the fan-in stamps on each frame.
//
// The fan-in aggregator (sse_fanin_aggregator.ts) writes a composite cursor as
// the `id:` on every frame in multi-peer mode: `local=5;studio=42`. Each event
// advances exactly one namespace's cursor value. By diffing the previous cursor
// against the current one, we identify which namespace originated the event.
//
// In fleet-of-one mode the `id:` is a bare scalar (no `=`): the function
// returns immediately — zero allocation, byte-identical to today.

/** Parse a composite cursor string into a namespace→value map.
 *
 *  - `"local=5;studio=42"` → `{local:"5", studio:"42"}`
 *  - `"42"` (bare scalar, fleet-of-one) → `{}`
 *  - `""` / undefined → `{}`
 *
 *  App-layer lightweight equivalent of sse_composite_cursor.ts's
 *  `parseCompositeCursor` — just enough to detect event origin. */
export function parseCursorNamespaces(id: string | undefined): Record<string, string> {
  if (!id || !id.includes("=")) return {}
  const result: Record<string, string> = {}
  for (const entry of id.split(";")) {
    if (entry === "") continue
    const eq = entry.indexOf("=")
    if (eq <= 0) continue
    result[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return result
}

/** Resolve which SSE namespace originated the event by diffing the event's
 *  composite cursor `id` against the previous cursor state.
 *
 *  Returns `undefined` for a local event (or fleet-of-one — bare scalar id,
 *  zero overhead), or the remote machine id string.
 *
 *  The composite cursor encodes ALL namespaces' positions in every event's
 *  `id:` field (e.g. `local=5;studio=42`). The namespace whose value changed
 *  from the previous cursor is the originator. */
export function resolveEventOrigin(
  currentId: string | undefined,
  previousCursor: Record<string, string>,
): { origin: string | undefined; cursor: Record<string, string> } {
  // Fleet-of-one: bare scalar (no `=`) — always local, zero overhead.
  if (!currentId || !currentId.includes("="))
    return { origin: undefined, cursor: previousCursor }

  const current = parseCursorNamespaces(currentId)
  let changed: string | undefined
  for (const ns of Object.keys(current)) {
    if (current[ns] !== previousCursor[ns]) {
      changed = ns
      break
    }
  }

  // "local" namespace or no detected change = local origin
  return {
    origin: changed && changed !== "local" ? changed : undefined,
    cursor: current,
  }
}
