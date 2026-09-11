# 0014 - Make the Work Column dockable and transactionally detachable

Status: proposed (2026-09-10)

Tracking: harmoniqs/amicode#977

The Work Column remains the app-owned auxiliary surface, but its desktop host may dock right, left, or bottom of Chat or move into a paired panel-only VS Code editor tab. Attached and detached modes are exclusive hosts for one durable Work Column record. They provide the same features and logical state, including Preview editing, rather than presenting copied or degraded views.

## Decision

Use an extension-owned, durable Work Column journal with generation-fenced host leases. Every transfer-relevant mutation is write-ahead journaled and acknowledged before the host treats it as committed. The attached host drains to a checksummed checkpoint, the destination hydrates read-only, and the durable lease compare-and-swaps to the destination only after an exact acknowledgement. Reattachment is the same transaction in reverse. Native panel disposal restores from the journal rather than attempting to extract state after close.

The source Chat is chat-only while detached. Its Side Panel control reports the external state and reveals the paired editor tab. If the source closes, the detached panel closes after its final checkpoint and the record becomes suspended and recoverable. No host closure discards the record by itself.

## Considered Options

1. **Durable record with transactional handoff** -- chosen. It is the only option that can preserve full functional parity and avoid drift across disposal, reload, and host failure.
2. **One-shot snapshot or renderer reparenting** -- rejected. DOM nodes, editor instances, PDF tasks, iframe runtimes, and post-close state cannot cross a webview boundary safely.
3. **Read-only detached Preview or detach refusal for dirty state** -- rejected. The detached Work Column must work exactly as attached mode, including editing.
4. **Extension-owned duplicate renderer** -- rejected. It would create two mutable implementations and a permanent state-drift risk.

## Consequences

The journal must carry serializable Preview state, editor undo/redo, pending save and close operations, widget snapshots and subscriptions, inspector sequence/replay buffers, and all relevant Work Column UI state. Widgets gain a suspend/resume contract. Cross-webview transfer is a deliberate exception to ADR 0013's in-document retained-renderer rule: normal tab moves preserve physical renderer identity, while detached moves preserve logical renderer state through checkpoint and hydration. The eight-document cap remains logical, although a transaction may briefly create source and destination renderers. Every durable record has a canonical codec version, checksum, owner identity, generation, and compare-and-swap lease predecessor so stale hosts cannot write.
