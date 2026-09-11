---
type: spec
schema_version: "1"
spec_id: spec-20260911-153000-home-scroll-snap-back
task_type: implement-slice
acceptance:
  - scroll_preserved_narrow_pct >= 100
  - scroll_preserved_polling_pct >= 100
  - skeleton_flash_on_refetch_count == 0
  - test_suite_pass_pct == 100
invariants:
  - widget iframes are never remounted by the fix — context/theme updates stay on the bridge
  - the overlay is never edited directly; all changes land in the opencode fork
  - no fix targets a component that is not rendered in the reporter's layout
baseline:
  none_because: "no prior fix attempt for this bug — first investigation"
---

# Fix scroll snap-back in the amicode dashboard (issue #1012)

## Amendment (round 2, blocking finding from adversarial review)

Round 1 targeted `HomeDesign` in `home.tsx`. The review found that in the
amicode v2 layout (`VITE_OPENCODE_CHANNEL=dev`, always ON for release builds),
the "/" route goes to `NewSessionLanding` (app.tsx:781), which immediately
redirects to a session. **`HomeDesign` is never rendered in the v2 route tree.**

This revision re-scopes the fix to the surfaces that actually render.

## Problem

On WSL2 (linux-x64, v0.3.4), scrolling down in the "Development projects
view" snaps the viewport back to the top. The scroll position is not
preserved — any attempt to scroll downward resets it.

## Affected surface — ambiguous, four candidates

In the v2 layout, there is no standalone "home page" at "/". The reporter's
"Development projects view" is one of these surfaces:

| # | Surface | File | Scroll container | Rendered? |
|---|---------|------|-------------------|-----------|
| S1 | Sessions flyout (titlebar) | `session-header.tsx:980` | `overflow: hidden auto`, max-height 70vh | **yes** — in v2 titlebar |
| S2 | Side-panel "home" tab (widgets) | `session-side-panel.tsx:284` | `overflow-y-auto` on flex-1 div | **yes** — in session side panel |
| S3 | WorkbenchPanel sidebar | `workbench-panel.tsx:55` | `overflow-y-auto` on flex-1 div | **yes** — when sidebar is open |
| S4 | HomeDesign (full dashboard) | `home.tsx:1078` | `overflow-y-auto` with `md:overflow-hidden` parent | **no** — not routed in v2 layout |

**Recommendation:** ask the reporter for a screen recording to identify the
exact surface. If that's not available, fix the shared patterns across all
four surfaces — the common root cause affects S1–S3 equally.

## Root causes (shared pattern across all surfaces)

### A. `sessionListDirectories` creates fresh arrays that cascade refetches

`sessionListDirectories()` (helpers.ts:69) always returns a new array. Every
consumer that uses the result as a memo or query key triggers unnecessary
downstream updates:

- **S1** (`session-header.tsx:730`): `activeSessions` memo calls
  `sessionListDirectories(ctx.projects.list(), ctx.sync.data?.project ?? [])`
  on every reactive tick. Each new array causes the memo to re-run, creating
  a new session list, triggering `<For each={filteredActiveSessions()}>` to
  re-render all rows.

- **S4** (`home.tsx:293`): `projectDirectories` memo passes the fresh array
  as a `queryKey` to `sessionLoad`, triggering a refetch. During refetch,
  `isLoading` flips true → session list unmounts → scroll resets.

**Evidence:** `sameProjectList` (home-projects.ts:126) already exists as a
structural comparator for the project reconcile path.

### B. `<Show>` gates unmount content during async loading transitions

Multiple surfaces wrap scrollable content in `<Show when={!loading}>` gates
that unmount the list on any refetch, not just the initial load:

- **S1** (`session-header.tsx:1070–1091`): nested `<Show>` gates on
  `filteredActiveSessions().length > 0`. When `activeSessions` recomputes
  (cause A), the list briefly becomes empty → Show unmounts → scroll resets.

- **S4** (`home.tsx:1354`): `<Show when={!homeCardsLoading()}>` unmounts the
  entire widget grid during resource refetch.

- **S2** (`session-side-panel.tsx:285–306`): `<Show when={widgetInfos().length > 0 && dashboard()}>` — same pattern.

### C. `home.tsx` responsive overflow gap (S4 only, if reached)

The parent container has `md:overflow-hidden` — below the Tailwind 768px
breakpoint, no clip is applied. This is S4-only and does not affect S1–S3.

## Approach

Three fixes, scoped to the patterns that affect S1–S3 (the rendered surfaces).
S4 fixes are included defensively since the component exists in the codebase.

### Fix 1 — Structural equality on `sessionListDirectories` consumers

Add a custom equality check to every memo that wraps `sessionListDirectories`:

**`home.tsx:293`** (S4):
```diff
  const projectDirectories = createMemo(() =>
    sessionListDirectories(projects(), focusedSync().data.project ?? []),
+   { equals: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]) }
  )
```

**`session-header.tsx:730`** (S1): the `activeSessions` memo calls
`sessionListDirectories` inside its body, not as a direct memo output. The
fix here is to extract the directories into their own memo with structural
equality, so the session computation only re-runs when directories actually
change:

```tsx
const flyoutDirectories = createMemo(
  () => {
    if (!open()) return []
    const conn = server.current
    if (!conn) return []
    const ctx = globalCtx.ensureServerCtx(conn)
    if (!ctx) return []
    return sessionListDirectories(ctx.projects.list(), ctx.sync.data?.project ?? [])
  },
  { equals: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]) }
)
```

Then `activeSessions` reads `flyoutDirectories()` instead of calling
`sessionListDirectories` inline.

### Fix 2 — Prevent cards unmount on refetch (S2 and S4)

**`session-side-panel.tsx:285`** (S2) and **`home.tsx:1354`** (S4): replace
binary `<Show when={!loading}>` with a visibility approach that keeps the
DOM alive during refetch. Show the skeleton only on initial load
(`!widgetsRaw.latest`); use CSS `visibility: hidden` during refetch.

SolidJS peer dep is `^1.9.0` — `.latest` is confirmed available.

### Fix 3 — `home.tsx` overflow-hidden gap (S4 defensive)

Drop the `md:` prefix so `overflow: hidden` applies at all widths:

```diff
- class="... m-2 min-h-0 md:overflow-hidden ..."
+ class="... m-2 min-h-0 overflow-hidden ..."
```

Defensive — S4 is not routed in v2, but the component exists and the CSS bug
is real.

## What could go wrong

1. **Fix 1 false equality:** `sessionListDirectories` could return arrays
   with the same strings in a different order. The equality check is
   order-sensitive. Mitigation: `sessionListDirectories` is deterministic
   (iterates `opened` then `serverProjects` in order), so order stability is
   guaranteed by its implementation (helpers.ts:69–89).

2. **Fix 2 stale data flash:** during refetch, the user sees stale widget
   cards instead of a skeleton. This is the intended trade-off — stale
   content is better than a scroll reset.

3. **Fix 3 narrow-width clipping:** if any layout below `md:` relied on the
   parent NOT clipping, those views break. Mitigation: the child already has
   `overflow-y-auto`, so the parent clip is safe.

4. **Surface ambiguity:** if the reporter's surface is S3 (WorkbenchPanel),
   none of these fixes apply — that component has no loading gates or
   `sessionListDirectories` calls. Its `overflow-y-auto` scroll container is
   straightforward. A snap-back there would indicate a different root cause
   (likely the VS Code webview or a parent layout mutation).

## Measurement

| Criterion | How measured |
|---|---|
| `scroll_preserved_narrow_pct` | Manual: open sessions flyout (S1), scroll down, wait 10s. Pass = position held. 5 trials. |
| `scroll_preserved_polling_pct` | Manual: open sessions flyout with a live solve running (polling every 2.5s), scroll down. Pass = position held after 3 polls. |
| `skeleton_flash_on_refetch_count` | Manual: open side panel "home" tab (S2), trigger a refetch. Count skeleton flashes in 3 trials. |
| `test_suite_pass_pct` | `pnpm --filter amicode test` — all pass. |

## Open question

**The exact surface has not been confirmed.** The spec fixes the shared
patterns across S1–S4 but cannot guarantee the reporter's surface is among
them. A screen recording from the reporter would resolve this. If the surface
turns out to be S3 (WorkbenchPanel) or the chat timeline virtualizer, a
separate investigation is needed.
