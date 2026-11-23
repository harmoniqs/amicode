// #2158: run `fn` in a Solid transition and resolve once `fn` has RUN, not
// when the transition settles. `await startTransition(fn)` waits for every
// resource read under the transition to load; Solid keeps one global
// transition, so on a busy engine a new chat's first send waited 10–30 s on
// the new session page's data (and concurrent new chats were released
// together). The navigation still happens inside the transition; only the
// caller's wait is shortened. The settle comes back as `settled` for callers
// that still need to know when the new page is on screen.
import { startTransition } from "solid-js"

type Start = (fn: () => void) => Promise<void>

export function whenTransitionStarted(
  fn: () => void,
  start: Start = startTransition,
): Promise<{ settled: Promise<void> }> {
  return new Promise((resolve, reject) => {
    // Filled in right after `start` returns. `fn` may run synchronously
    // inside `start` (when a transition is already running), but the awaiting
    // caller resumes on a later microtask, after the assignment below.
    const result = {} as { settled: Promise<void> }
    const done = start(() => {
      try {
        fn()
      } catch (err) {
        reject(err)
        return
      }
      resolve(result)
    })
    result.settled = done.catch(() => undefined)
    done.catch(reject)
  })
}
