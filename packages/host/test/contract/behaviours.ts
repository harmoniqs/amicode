// Small behavioural contracts beyond "the export exists": the semantics server-seam.ts leans on. Each returns
// a problem string, or undefined when the behaviour holds. Run inside probe.ts (sandboxed child).
// Imports go through the same dynamic-import style as the seam so a planted break (shim.ts) shows up here too.

export const behaviours: Record<string, () => Promise<string | undefined>> = {
  "effect: Scope finalizers run last-registered-first (the seam counts open streams on this ordering)": async () => {
    const { Effect, Exit, Scope } = await import("effect")
    const order: string[] = []
    const scope = await Effect.runPromise(Scope.make())
    await Effect.runPromise(Scope.addFinalizer(scope, Effect.sync(() => void order.push("first-registered"))))
    await Effect.runPromise(Scope.addFinalizer(scope, Effect.sync(() => void order.push("second-registered"))))
    await Effect.runPromise(Scope.close(scope, Exit.void))
    return order.join(",") === "second-registered,first-registered" ? undefined : `finalizer order was ${order.join(",")}`
  },

  "effect: Effect.runPromise resolves a sync effect; Effect.runFork forks one that completes": async () => {
    const { Effect } = await import("effect")
    const value = await Effect.runPromise(Effect.sync(() => 40 + 2))
    if (value !== 42) return `runPromise(sync) gave ${String(value)}`
    let ran = false
    Effect.runFork(Effect.sync(() => void (ran = true)))
    await Bun.sleep(25)
    return ran ? undefined : "runFork did not run the effect"
  },

  "effect: Layer.buildWithScope builds a service into a Context that Context.get reads, and closing the scope runs its finalizer": async () => {
    const { Context, Effect, Exit, Layer, Scope } = await import("effect")
    class Probe extends Context.Service<Probe, { readonly n: number }>()("contract/Probe") {}
    let released = false
    const layer = Layer.effect(
      Probe,
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => void (released = true)))
        return { n: 7 }
      }),
    )
    const scope = await Effect.runPromise(Scope.make())
    const context = await Effect.runPromise(Layer.buildWithScope(layer, scope))
    if (Context.get(context, Probe).n !== 7) return "Context.get did not return the built service"
    await Effect.runPromise(Scope.close(scope, Exit.void))
    return released ? undefined : "closing the scope did not run the layer's finalizer"
  },

  "@opencode/server/routes: createRoutes(options, serviceURLs) returns a Layer without starting anything": async () => {
    const { createRoutes } = await import("@opencode/server/routes")
    const layer = createRoutes({ app: { name: "contract", version: "0" }, models: { fetch: false } } as never, () => [])
    return typeof layer === "object" && layer !== null && typeof (layer as { pipe?: unknown }).pipe === "function" ? undefined : "createRoutes did not return a pipeable Layer"
  },
}
