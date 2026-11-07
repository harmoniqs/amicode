// SSE COMPOSITE CURSOR (#1511, ADR 0033 §D3) — the per-namespace cursor set
// that generalizes #1264's single scalar.
//
// The app still sends ONE opaque `?lastEventID=<value>` (no client change
// beyond value opacity). That value is a COMPOSITE the origin parses into a
// per-namespace resume map:
//
//     local=<id>;<machineIdA>=<idA>;<machineIdB>=<idB>
//
// The origin re-subscribes each upstream with ITS OWN resume id and replays the
// local arm from `local`'s id. `format(parse(x)) === x` for every well-formed
// composite. A bare scalar (no `=`) is the #1264 back-compat form — the local
// arm's position — so a client that upgraded mid-stream (its persisted cursor is
// still a bare seq) resumes the local arm cleanly.

/** The reserved namespace for the always-present local event source (§D4). */
export const LOCAL_NAMESPACE = "local";

/** The unit separator (U+001F) joining a peer frame's owner + upstream id in a
 *  single namespaced `id:` token, `<machineId>␟<peerId>` (§D2). Distinct from
 *  the composite cursor's `=`/`;` so the two encodings never collide. */
export const NS_SEP = "\u001f";

/** Parse an opaque client cursor into a per-namespace resume map.
 *
 *  - `"local=5;studio=42"` → Map{local:"5", studio:"42"} (the composite form).
 *  - `"42"` (a bare scalar, no `=`) → Map{local:"42"} (#1264 back-compat: the
 *    scalar is the local arm's position).
 *  - `""` / undefined / null → an empty map (a fresh connect, no resume).
 *
 *  Malformed entries (empty key) are skipped rather than throwing — a corrupt
 *  cursor degrades to a fresh subscribe of the affected namespace, never a
 *  crash. Insertion order is preserved so `format(parse(x)) === x`. */
export function parseCompositeCursor(cursor: string | undefined | null): Map<string, string> {
  const out = new Map<string, string>();
  if (cursor === undefined || cursor === null) return out;
  const trimmed = cursor.trim();
  if (trimmed === "") return out;
  // A single token with no `=` is the #1264 bare local scalar.
  if (!trimmed.includes("=")) {
    out.set(LOCAL_NAMESPACE, trimmed);
    return out;
  }
  for (const entry of trimmed.split(";")) {
    if (entry === "") continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) continue; // no `=`, or an empty key — skip
    const key = entry.slice(0, eq);
    const val = entry.slice(eq + 1);
    out.set(key, val);
  }
  return out;
}

/** Format a per-namespace resume map back into the opaque composite cursor.
 *  `local=<id>;<machineId>=<id>`, in the map's insertion order. Round-trips:
 *  `formatCompositeCursor(parseCompositeCursor(x)) === x` for every well-formed
 *  composite `x`. */
export function formatCompositeCursor(map: Map<string, string>): string {
  const parts: string[] = [];
  for (const [key, val] of map) {
    if (key === "") continue;
    parts.push(`${key}=${val}`);
  }
  return parts.join(";");
}
