// The composer's send guard needs an agent and a usable model, both read from
// the engine's per-directory catalog (agent list + connected providers). The
// directory bootstrap loads the agent list ONCE; if that request fails — e.g.
// while the engine re-initialises after a rebuild re-stages its config — the
// list stays empty for the window's lifetime and every send was refused with
// "Select an agent and model", even though a model was picked. The guard now
// reloads the catalog once and re-reads before refusing, and the refusal names
// what is actually missing. It never invents an agent: an unresolved agent is
// refused, not defaulted to `build` (that would silently escalate a plan-mode
// chat to write access).

export type CatalogMissing = "none" | "agent" | "model"

export type CatalogResolution<M, A> = {
  model: M | undefined
  agent: A | undefined
  /** What is still unresolved after the (at most one) reload. An unresolved
   *  agent wins over a model — without agents the catalog itself didn't load. */
  missing: CatalogMissing
  reloaded: boolean
}

const classify = (model: unknown, agent: unknown): CatalogMissing => {
  if (!agent) return "agent"
  if (!model) return "model"
  return "none"
}

/** Read the selection; when anything is missing, reload the catalog once
 *  (bounded by `timeoutMs`, failures swallowed) and read again. */
export async function resolveWithCatalogRecovery<M, A>(input: {
  read: () => { model: M | undefined; agent: A | undefined }
  reload: () => Promise<unknown>
  timeoutMs?: number
}): Promise<CatalogResolution<M, A>> {
  const first = input.read()
  if (classify(first.model, first.agent) === "none") {
    return { ...first, missing: "none", reloaded: false }
  }

  const timeoutMs = input.timeoutMs ?? 8_000
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.resolve()
      .then(input.reload)
      .catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    }),
  ])
  if (timer !== undefined) clearTimeout(timer)

  const second = input.read()
  return { ...second, missing: classify(second.model, second.agent), reloaded: true }
}

/** Single-flight wrapper: concurrent reloads for the same key share one request. */
export function singleFlight<K>(run: (key: K) => Promise<unknown>) {
  const pending = new Map<K, Promise<unknown>>()
  return (key: K) => {
    const existing = pending.get(key)
    if (existing) return existing
    const promise = run(key).finally(() => pending.delete(key))
    pending.set(key, promise)
    return promise
  }
}
