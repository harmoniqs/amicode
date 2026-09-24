// SSE FAN-IN AGGREGATOR (#1511, ADR 0033 §D1–D4 + decisions A/A/B) — the
// origin-side aggregator that makes "interact with a peer's session as if local"
// real: it fans IN each reachable owner-peer's event stream and the always-
// present local event source onto the ONE downstream `/event` response the app
// already reads (ADR 0027 single-origin — the app keeps exactly one connection).
//
//   §D1 — fan-in membership: local arm + one upstream per reachable owner-peer
//         holding ≥1 owned session; an unreachable owner emits an honest comment
//         frame, never a silent gap.
//   §D2 — `id:`-verbatim namespaced relay + a `pipeToResponse` adapter.
//   §D3 — a composite cursor (sse_composite_cursor.ts) parsed at the origin.
//   §D4 — the local arm is ALWAYS present; fleet-of-one is byte-identical to
//         today's single local stream (the #1264 regression guard).
//   decision A — per-peer auth (each upstream reads its OWN peer-store token).
//   decision A — focus snapshot as the first `local`-namespace frame at connect.
//   decision B — per-namespace bounded buffers (an overflowing peer degrades in
//         isolation; its cursor resumes the gap on recovery via §D3).
//
// Design: a synchronous frame-routing CORE (this file) that a test drives
// deterministically, plus a thin async driver (the real http upstreams) that the
// two-peer E2E exercises. All 7 ACs live in the core.
import {
  LOCAL_NAMESPACE,
  NS_SEP,
  parseCompositeCursor,
  formatCompositeCursor,
} from "./sse_composite_cursor";

export { LOCAL_NAMESPACE, NS_SEP } from "./sse_composite_cursor";

// ── transport-shaped interfaces (injectable; a test fakes them) ──────────────

/** A source of raw SSE frame blocks (delimiter-inclusive). `next()` resolves to
 *  the next whole frame, or null when the source ends. */
export interface SseFrameSource {
  next(): Promise<string | null>;
  close(): void;
}

/** The downstream response, narrowed to what the relay needs. In production an
 *  `http.ServerResponse`; in tests a collecting fake. `flush` is optional (not
 *  every response object exposes it). */
export interface SseSink {
  write(chunk: string): void;
  flush?(): void;
}

/** The focus/picker snapshot folded into the connect frame (decision A). */
export interface FocusSnapshot {
  focusedMachineId?: string;
  isHome: boolean;
  absent: boolean;
  reason?: string;
}

// ── SSE frame helpers (mirrors session_event_resume framing conventions) ─────

/** The end-of-line style a frame uses (CRLF if any `\r\n` present, else LF). */
function eolOf(rawFrame: string): string {
  return rawFrame.includes("\r\n") ? "\r\n" : "\n";
}

/** The frame's event id = its LAST `id:` line (SSE last-wins), or undefined for
 *  an id-less frame (a comment/heartbeat, or an `id:` with an empty value). An
 *  id-less frame must NOT advance its namespace (§D3 / AC4). */
export function frameRawId(rawFrame: string): string | undefined {
  let id: string | undefined;
  for (const line of rawFrame.split(/\r?\n/)) {
    if (line.startsWith("id:")) {
      const v = line.slice(3).replace(/^ /, "");
      id = v;
    }
  }
  return id === undefined || id === "" ? undefined : id;
}

/** Rebuild a frame with its `id:` line set to `newId` (or removed when null),
 *  preserving every other line (`event:`/`data:`/`retry:`/comments) verbatim.
 *  The single canonical `id:` line is placed just before the trailing blank so
 *  the frame stays well-formed; original id lines are dropped (SSE last-wins). */
function rewriteFrameId(rawFrame: string, newId: string | null): string {
  const eol = eolOf(rawFrame);
  const tokens = rawFrame.split(eol);
  const out: string[] = [];
  for (const tok of tokens) {
    if (tok.startsWith("id:")) continue; // drop original id line(s)
    out.push(tok);
  }
  if (newId !== null) {
    let insertAt = out.length;
    while (insertAt > 0 && out[insertAt - 1] === "") insertAt--;
    out.splice(insertAt, 0, `id: ${newId}`);
  }
  return out.join(eol);
}

/** The §D2 relay: preserve a frame's `event:`/`data:`/`retry:` lines and
 *  namespace its `id:` as `<namespace>␟<rawId>` (U+001F). An id-less frame is
 *  passed through verbatim (nothing to namespace). This is the single-arm relay
 *  building block; the aggregator folds the namespaced id into the composite for
 *  the shared downstream. */
export function relayFrame(namespace: string, rawFrame: string): string {
  const rawId = frameRawId(rawFrame);
  if (rawId === undefined) return rawFrame;
  return rewriteFrameId(rawFrame, `${namespace}${NS_SEP}${rawId}`);
}

/** The §D2 `res` adapter: pump every frame from one source onto the sink as
 *  well-formed, namespaced SSE bytes, flushing per frame so nothing buffers
 *  head-of-line. Ends when the source ends. */
export async function pipeToResponse(
  source: SseFrameSource,
  sink: SseSink,
  opts: { namespace: string },
): Promise<void> {
  for (;;) {
    const f = await source.next();
    if (f === null) break;
    sink.write(relayFrame(opts.namespace, f));
    sink.flush?.();
  }
}

// ── the aggregator core ──────────────────────────────────────────────────────

export interface SseFanInOptions {
  /** The one downstream `/event` response every arm fans into. */
  sink: SseSink;
  /** This machine's own id (diagnostics / self-exclusion). */
  localMachineId?: string;
  /** Per-namespace bounded buffer size (decision B). Default 256. */
  bufferBound?: number;
  /** Focus/picker snapshot provider (decision A). When absent, no focus frame
   *  is emitted — the fleet-of-one passthrough stays strictly byte-identical. */
  focusSnapshot?: () => FocusSnapshot | undefined;
}

export class SseFanInAggregator {
  private readonly sink: SseSink;
  private readonly localMachineId: string;
  private readonly bufferBound: number;
  private readonly focusProvider?: () => FocusSnapshot | undefined;

  /** namespace → last delivered upstream id (the composite cursor state). */
  private readonly composite = new Map<string, string>();
  /** the active PEER namespaces (never includes `local`). */
  private readonly peerArms = new Set<string>();

  constructor(opts: SseFanInOptions) {
    this.sink = opts.sink;
    this.localMachineId = opts.localMachineId ?? "";
    this.bufferBound = opts.bufferBound ?? 256;
    this.focusProvider = opts.focusSnapshot;
  }

  /** Begin (or reconnect): parse the client's opaque composite cursor into the
   *  per-namespace resume map, seed the composite state, and emit the focus
   *  snapshot as the FIRST `local`-namespace frame (decision A — self-healing
   *  cold-seed on every reconnect). Returns the per-namespace resume map so the
   *  driver re-subscribes each upstream with its own resume id (§D3). */
  connect(cursor?: string): Map<string, string> {
    const resume = parseCompositeCursor(cursor);
    this.composite.clear();
    for (const [k, v] of resume) this.composite.set(k, v);
    if (this.focusProvider) this.emitFocusFrame();
    return new Map(resume);
  }

  /** Ingest one raw SSE frame from an arm. `namespace === "local"` for the local
   *  arm; a machineId for a peer arm. */
  ingest(namespace: string, rawFrame: string): void {
    const rawId = frameRawId(rawFrame);
    const fleetOfOne = this.peerArms.size === 0;

    if (namespace === LOCAL_NAMESPACE && fleetOfOne) {
      // §D4 / AC1 byte-identity: with no peer arms the local frame is written
      // VERBATIM (bare id, every line untouched). The composite still tracks the
      // local position silently, so a peer that joins mid-stream inherits it.
      if (rawId !== undefined) this.composite.set(LOCAL_NAMESPACE, rawId);
      this.sink.write(rawFrame);
      this.sink.flush?.();
      return;
    }

    // Composite mode (≥1 peer arm active): every arm's frames carry the full
    // composite id so the client holds all N namespaces' positions at once.
    if (rawId !== undefined) this.composite.set(namespace, rawId);
    const wire = rewriteFrameId(rawFrame, formatCompositeCursor(this.composite));
    this.sink.write(wire);
    this.sink.flush?.();
  }

  /** The current composite cursor string (the last `id:` the client has seen). */
  cursor(): string {
    return formatCompositeCursor(this.composite);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private emitFocusFrame(): void {
    const snapshot = this.focusProvider?.() ?? { isHome: true, absent: false };
    const payload = JSON.stringify({ type: "amicode.fleet.focus", ...snapshot });
    // The focus frame rides the `local` namespace. It carries no monotonic id
    // (it is a snapshot, not a resumable event) so it never advances a cursor.
    this.sink.write(`event: amicode.fleet.focus\ndata: ${payload}\n\n`);
    this.sink.flush?.();
  }
}
