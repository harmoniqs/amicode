// #2157: the new-chat submit gate. Starting a new chat creates the session at
// submit, but the composer keeps its text until the create, the navigation
// transition and the first send have all finished — seconds on a busy engine.
// Without a gate, pressing Enter again in that window created a second session
// and sent it the same text (one duplicate tab per press). The gate admits one
// new-session submit per draft at a time; it is keyed by the draft so two
// different drafts (two panes) can still start sessions concurrently, and it
// is module-level so a composer remount mid-create cannot reset it. The
// caller supplies the key (submit.ts: ScopedKey of scope, directory, draft id).

const inFlight = new Set<string>()

/** Admit a new-session submit from this draft, or refuse it while one is in
 *  flight. Every `true` must be paired with exactly one `releaseNewSessionSubmit`. */
export function tryEnterNewSessionSubmit(key: string): boolean {
  if (inFlight.has(key)) return false
  inFlight.add(key)
  return true
}

export function releaseNewSessionSubmit(key: string): void {
  inFlight.delete(key)
}

/** Run one new-session submit under the gate: a concurrent call from the same
 *  draft resolves to `false` without running; the gate is released however
 *  `run` settles (sent, failed create, thrown error), so the next submit retries. */
export async function withNewSessionGate(key: string, run: () => Promise<void>): Promise<boolean> {
  if (!tryEnterNewSessionSubmit(key)) return false
  try {
    await run()
  } finally {
    releaseNewSessionSubmit(key)
  }
  return true
}
