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
import { peerAuthHeader } from "./merged_projection";
import type { PeerTokenRead } from "./fleet_peer_store";

export { LOCAL_NAMESPACE, NS_SEP } from "./sse_composite_cursor";

// ── transport-shaped interfaces (injectable; a test fakes them) ──────────────

/** A source of raw SSE frame blocks (delimiter-inclusive). `next()` resolves to
 *  the next whole frame, or null when the source ends.
 *
 *  #1617 — `pause()` / `resume()` are OPTIONAL flow control the driver drives
 *  when the shared downstream backpressures: pausing every live upstream while
 *  the downstream is stalled is what keeps the bounded per-namespace buffers
 *  from overflow-dropping (the overflow is otherwise UNRECOVERABLE — the live
 *  global event route has no replay cursor). A source that cannot pause simply
 *  omits them; the aggregator falls back to buffer-and-drain (today's behavior
 *  for injected test sources) — additive, no existing caller breaks. */
export interface SseFrameSource {
  next(): Promise<string | null>;
  close(): void;
  /** #1617 — stop pulling from the upstream while the downstream is stalled. */
  pause?(): void;
  /** #1617 — resume pulling once the downstream has drained. */
  resume?(): void;
}

/** The downstream response, narrowed to what the relay needs. In production an
 *  `http.ServerResponse`; in tests a collecting fake. `write` returns `false`
 *  when the downstream is backpressured (the Node `res.write` convention) — the
 *  aggregator reads that to switch a namespace to its bounded buffer (decision
 *  B). `flush` is optional (not every response object exposes it). */
export interface SseSink {
  write(chunk: string): boolean | void;
  flush?(): void;
}

/** The focus/picker snapshot folded into the connect frame (decision A). */
export interface FocusSnapshot {
  focusedMachineId?: string;
  isHome: boolean;
  absent: boolean;
  reason?: string;
}

/** One owner-peer in the fan-in membership (§D1). Derived from the
 *  SessionOwnerMap: a peer holding ≥1 owned session. `reachable` + a usable
 *  `token` make it an active arm; otherwise it is a NAMED unavailable source,
 *  never a silent gap and never a local fallback. */
export interface PeerMember {
  machineId: string;
  /** transport reachable (the peer's late-bound URL resolved). */
  reachable: boolean;
  /** the peer's OWN token, read from the peer-store per upstream (decision A).
   *  Absent/empty → the peer is a named unavailable source. */
  token?: string;
  /** the reason the peer is unusable, when reachable is false or the token is
   *  absent/invalid (surfaced in the honest comment frame). */
  reason?: string;
}

/** The per-peer upstream auth decision (decision A). Either the peer's OWN
 *  Authorization header (derived solely from its peer-store token — the hub
 *  credential is NEVER an input here) or a NAMED unavailable reason. */
export type UpstreamAuth =
  | { ok: true; machineId: string; authHeader: string }
  | { ok: false; machineId: string; reason: "token-absent" | "token-malformed" | "token-incomplete" };

/** Resolve the Authorization header for ONE peer upstream from that peer's own
 *  peer-store credential (decision A). The hub-mint credential is not a
 *  parameter and can never be forwarded. An absent/invalid token yields a named
 *  unavailable reason — never a header, never a silent local fallback. */
export function resolveUpstreamAuth(machineId: string, tokenRead: PeerTokenRead): UpstreamAuth {
  if (tokenRead.ok) {
    return { ok: true, machineId, authHeader: peerAuthHeader(tokenRead.credential.token) };
  }
  const reason = tokenRead.reason === "absent" ? "token-absent"
    : tokenRead.reason === "malformed" ? "token-malformed"
    : "token-incomplete";
  return { ok: false, machineId, reason };
}

/** An honest SSE comment frame naming an unavailable source (§D1 / AC2 —
 *  mirrors the FLEET_PEER_UNREACHABLE honest-source posture). Carries no `id:`,
 *  so it never advances any namespace's cursor. */
export function honestSourceComment(machineId: string, reason: string): string {
  return `: amicode.fleet source ${machineId} unavailable (${reason})\n\n`;
}

/** Derive the fan-in membership (§D1) from the SessionOwnerMap's owner set. One
 *  PeerMember per DISTINCT remote owner-peer (local excluded): reachable + its
 *  OWN peer-store token (decision A). A peer that is unreachable or whose token
 *  is absent/invalid rides through as a token-less/unreachable member so
 *  `setMembership` names it unavailable — never silently omitted, never local. */
export function deriveMembership(opts: {
  ownerMachineIds: string[];
  localMachineId: string;
  reachable: (machineId: string) => boolean;
  peerToken: (machineId: string) => PeerTokenRead;
}): PeerMember[] {
  const out: PeerMember[] = [];
  for (const machineId of opts.ownerMachineIds) {
    if (machineId === "" || machineId === opts.localMachineId) continue;
    const reachable = opts.reachable(machineId);
    const tokenRead = opts.peerToken(machineId);
    const reason = !reachable ? "peer-unreachable" : !tokenRead.ok ? `token-${tokenRead.reason}` : undefined;
    out.push({
      machineId,
      reachable,
      ...(tokenRead.ok ? { token: tokenRead.credential.token } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });
  }
  return out;
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
  /** #1617 — invoked EACH time a downstream `write()` returns false (the
   *  flowing→backpressured transition). The driver wires this to pause its live
   *  upstream sources, so under sustained backpressure the bounded per-namespace
   *  buffers cannot overflow-drop. Absent ⇒ buffer-and-drain only (today's
   *  behavior for injected test sources). */
  onBackpressure?: () => void;
}

export class SseFanInAggregator {
  private readonly sink: SseSink;
  private readonly bufferBound: number;
  private readonly focusProvider?: () => FocusSnapshot | undefined;
  private readonly onBackpressure?: () => void;

  /** namespace → last delivered upstream id (the composite cursor state). */
  private readonly composite = new Map<string, string>();
  /** the active PEER namespaces (never includes `local`). */
  private readonly peerArms = new Set<string>();
  /** owner-peers currently NAMED unavailable (unreachable / token-less). */
  private readonly unavailable = new Set<string>();
  /** decision B — is the shared downstream currently accepting writes? A
   *  `write()` returning false flips this off; `resume()` flips it back and
   *  drains the pending stream. */
  private flowing = true;
  /** decision B / #1638 — the ONE ordered pending stream on the shared
   *  downstream. Data frames (per-namespace, isolation-bounded) and control
   *  frames (gap/focus/comment) share this queue so a control frame written
   *  during backpressure NEVER jumps ahead of buffered data frames, nor is
   *  swallowed into a full sink: it drains interleaved by true arrival order.
   *  Per-namespace overflow isolation is kept by counting live data entries per
   *  namespace against `bufferBound` — an overflowing peer's frame is dropped in
   *  isolation (its cursor stays at the last delivered id) without touching any
   *  other namespace or a control frame's ordering. */
  private readonly pending: Array<
    { kind: "data"; namespace: string; frame: string } | { kind: "control"; frame: string }
  > = [];
  /** decision B — per-namespace overflow drop counts (the gap D3 resumes). */
  private readonly droppedCount = new Map<string, number>();
  /** #1638 — namespaces whose arm has EVER delivered a frame this connection.
   *  A re-open of an arm not in this set is the INITIAL open (no gap); a re-open
   *  of one already here is a NON-INITIAL re-open (the #1601 path → gap in
   *  composite mode). */
  private readonly everDelivered = new Set<string>();
  /** #1617 (fleet-of-one) — frames stranded on the zero-peer VERBATIM path while
   *  the downstream is backpressured. Kept SEPARATE from the composite `buffers`
   *  because these flush byte-for-byte (raw `sink.write`, no composite-id rewrite)
   *  to preserve the #1264 byte-identity guard — a wedge in solo mode must heal
   *  without ever entering the namespaced/composite delivery path. */
  private readonly verbatimBuffer: string[] = [];

  constructor(opts: SseFanInOptions) {
    this.sink = opts.sink;
    this.bufferBound = opts.bufferBound ?? 256;
    this.focusProvider = opts.focusSnapshot;
    this.onBackpressure = opts.onBackpressure;
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

  /** Reconcile the fan-in membership from the SessionOwnerMap (§D1 / AC2). Each
   *  reachable owner-peer with a usable token becomes an active upstream arm;
   *  peers are added/removed as ownership changes. A reachable-but-token-less or
   *  unreachable owner-peer is a NAMED unavailable source — an honest comment
   *  frame on transition into unavailable, never a silent gap, never local. */
  setMembership(peers: PeerMember[]): void {
    const seen = new Set<string>();
    for (const peer of peers) {
      seen.add(peer.machineId);
      const usable = peer.reachable && typeof peer.token === "string" && peer.token.trim() !== "";
      if (usable) {
        this.peerArms.add(peer.machineId);
        this.unavailable.delete(peer.machineId);
      } else {
        this.peerArms.delete(peer.machineId);
        if (!this.unavailable.has(peer.machineId)) {
          this.unavailable.add(peer.machineId);
          const reason = peer.reason ?? (peer.reachable ? "token-absent" : "peer-unreachable");
          // #1638 — routed through the return-checked, order-preserving control
          // helper so the honest comment never jumps ahead of buffered data.
          this.writeControl(honestSourceComment(peer.machineId, reason));
        }
      }
    }
    // Owner-peers no longer in the map (their sessions ended) drop their arm —
    // this is not an unavailability, so no comment frame.
    for (const id of [...this.peerArms]) if (!seen.has(id)) this.peerArms.delete(id);
    for (const id of [...this.unavailable]) if (!seen.has(id)) this.unavailable.delete(id);
  }

  /** The active PEER upstream arms (excludes `local`, excludes unavailable
   *  owner-peers). The driver opens/closes real upstreams to match this set. */
  activeArms(): string[] {
    return [...this.peerArms];
  }

  /** The owner-peers currently NAMED unavailable — surfaced, never dropped. */
  unavailableSources(): string[] {
    return [...this.unavailable];
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
      if (rawId !== undefined) {
        this.composite.set(LOCAL_NAMESPACE, rawId);
        this.everDelivered.add(LOCAL_NAMESPACE);
      }
      // #1617 (fleet-of-one) — honor backpressure on the verbatim path too. When
      // the downstream is already backpressured, hold the frame VERBATIM in the
      // verbatim buffer (never namespaced) so it is not fired into an over-full
      // socket where a stranded `session.status: idle` would wedge the rail until
      // reload. When flowing, write it directly and, if THIS write backpressures,
      // flip flowing off + signal the driver to pause the local upstream. This
      // changes only TIMING — not a byte — so the #1264 guard holds.
      if (!this.flowing) {
        this.verbatimBuffer.push(rawFrame);
        return;
      }
      const accepted = this.sink.write(rawFrame);
      this.sink.flush?.();
      if (accepted === false) {
        this.flowing = false;
        this.onBackpressure?.();
      }
      return;
    }

    // Composite mode (≥1 peer arm active): every arm's frames carry the full
    // composite id so the client holds all N namespaces' positions at once.
    // decision B — when the shared downstream is flowing, deliver directly;
    // when it is backpressured, enqueue onto the ONE ordered pending stream
    // (bounded per-namespace, isolated).
    if (this.flowing) {
      this.deliver(namespace, rawFrame);
    } else {
      this.enqueue(namespace, rawFrame);
    }
  }

  /** Drain the ordered pending stream after the downstream drains (decision B /
   *  #1638). Data + control entries flush in true ARRIVAL ORDER — a control
   *  frame written during backpressure never jumps ahead of the data frames that
   *  preceded it. If the sink backpressures again mid-drain, the remaining
   *  entries stay pending in order (a dropped namespace's cursor still resumes
   *  the gap).
   *
   *  #1638 — the only added guard is a NO-OP WHEN ALREADY FLOWING: `resume()` is
   *  called on the downstream `drain` edge, which only fires after a stall, so a
   *  spurious resume() while flowing must not re-flush/duplicate. It is NOT a
   *  "no-op when the sink is full" — that would strand #1617's idle frame.
   *
   *  #1617 — this is the seam the downstream `drain` edge drives. After the
   *  pending stream drains, if any namespace overflow-DROPPED while
   *  backpressured, emit exactly one gap signal naming those namespaces and zero
   *  their counters. The gap is emitted HERE, at resume time — never into a
   *  backpressured sink. If the drain flushed cleanly (flowing stays true) the
   *  gap goes out; if the sink re-stalled mid-drain the drops persist and the
   *  next resume() carries the gap. */
  resume(): void {
    if (this.flowing) return; // #1638 — no-op WHEN ALREADY FLOWING (never "when full")
    this.flowing = true;
    // #1617 (fleet-of-one) — flush the VERBATIM buffer first, byte-for-byte (no
    // composite-id rewrite), so a solo-mode wedge heals without ever touching the
    // namespaced path (the #1264 guard). If the sink backpressures again mid-drain
    // the remaining frames stay buffered in order, flowing flips off, and the next
    // drain resumes them.
    while (this.verbatimBuffer.length > 0 && this.flowing) {
      const frame = this.verbatimBuffer.shift()!;
      const accepted = this.sink.write(frame);
      this.sink.flush?.();
      if (accepted === false) {
        this.flowing = false;
        this.onBackpressure?.();
      }
    }
    // #1638 — drain the ONE ordered pending stream in arrival order: data frames
    // through deliver() (composite-id rewrite + cursor advance), control frames
    // written raw. This is what interleaves gap/focus/comment frames correctly
    // relative to buffered data.
    while (this.pending.length > 0 && this.flowing) {
      const entry = this.pending.shift()!;
      if (entry.kind === "data") this.deliver(entry.namespace, entry.frame);
      else this.writeControlRaw(entry.frame);
    }
    if (this.flowing) this.emitGapIfDropped();
  }

  /** #1638 — the ONE return-checked, order-preserving control-write helper. A
   *  control frame (gap/focus/comment) must not jump ahead of buffered data
   *  frames nor be swallowed into a full sink: when backpressured, it ENQUEUES
   *  onto the same ordered pending stream (draining interleaved by arrival
   *  order); when flowing, it writes directly and the return is CHECKED — a
   *  write() that backpressures flips flowing off and signals the driver, exactly
   *  like a data frame. */
  private writeControl(frame: string): void {
    if (!this.flowing) {
      this.pending.push({ kind: "control", frame });
      return;
    }
    this.writeControlRaw(frame);
  }

  /** Write a control frame directly (flowing path, and the resume() drain path).
   *  Return-checked: a backpressuring write flips flowing off + signals pause. */
  private writeControlRaw(frame: string): void {
    const accepted = this.sink.write(frame);
    this.sink.flush?.();
    if (accepted === false && this.flowing) {
      this.flowing = false;
      this.onBackpressure?.();
    }
  }

  /** #1638 — a peer/local arm is being RE-OPENED (the #1601 reconcile path). In
   *  composite mode (≥1 peer arm) a NON-INITIAL re-open forces a client refetch
   *  via exactly one id-less `amicode.sync.gap` naming that namespace, because
   *  the upstream `/global/event` route does NOT replay on `?lastEventID` (Step 0
   *  = no replay) so the cursor-advance alone cannot recover the reconnect gap.
   *  In FLEET-OF-ONE (zero peers) NO gap is emitted — a synthetic frame in the
   *  verbatim stream would violate the #1264 byte-identity guard; the solo-mode
   *  arm re-opens silently (its verbatim stream stays frame-for-frame identical).
   *  The INITIAL open of an arm (never delivered a frame) emits no gap either —
   *  only a re-open of an arm that has already delivered. */
  reopenArm(namespace: string): void {
    if (this.peerArms.size === 0) return; // fleet-of-one → NO synthetic frame (#1264)
    if (!this.everDelivered.has(namespace)) return; // initial open → no gap
    const data = JSON.stringify({ type: "amicode.sync.gap", namespaces: [namespace] });
    this.writeControl(`event: amicode.sync.gap\ndata: ${data}\n\n`);
  }

  /** #1617 — the overflow defense-in-depth. When resume() observes a nonzero
   *  drop count for any namespace, emit ONE `amicode.sync.gap` frame carrying
   *  those namespaces and zero their counters. The frame is id-less (never
   *  advances a cursor) and meets the client's two hard shape requirements: it
   *  carries a `data:` line (the SSE parser drops a data-less frame) and its
   *  JSON has NO top-level `payload` key (the client routes on `"payload" in
   *  event` — a payload-less bare-JSON frame takes the adapter path where the
   *  gap type match lives). Routed through the return-checked control helper. */
  private emitGapIfDropped(): void {
    const dropped: string[] = [];
    for (const [ns, n] of this.droppedCount) if (n > 0) dropped.push(ns);
    if (dropped.length === 0) return;
    const data = JSON.stringify({ type: "amicode.sync.gap", namespaces: dropped });
    this.writeControl(`event: amicode.sync.gap\ndata: ${data}\n\n`);
    for (const ns of dropped) this.droppedCount.set(ns, 0);
  }

  /** The number of frames DROPPED for a namespace on buffer overflow (decision
   *  B). Nonzero means a gap that the namespace's D3 cursor resumes on recovery. */
  dropped(namespace: string): number {
    return this.droppedCount.get(namespace) ?? 0;
  }

  /** The current composite cursor string (the last `id:` the client has seen). */
  cursor(): string {
    return formatCompositeCursor(this.composite);
  }

  /** #1638 — the live per-namespace last-DELIVERED id (the composite map's
   *  entry for `namespace`), or undefined if the arm has delivered no id'd frame
   *  yet. The driver reads this at re-open time to resume the arm from its
   *  last-delivered position rather than the stale connect-time cursor — honoring
   *  #1617's own cursor invariant. Advances per delivered frame on BOTH the
   *  composite and the verbatim path; an id-less frame never advances it. */
  cursorFor(namespace: string): string | undefined {
    return this.composite.get(namespace);
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Write one frame downstream in composite mode: advance the namespace's
   *  cursor from the frame's id, stamp the full composite as the wire `id:`,
   *  write + flush. A `write()` returning false backpressures the shared
   *  downstream (subsequent frames enqueue onto the ordered pending stream). */
  private deliver(namespace: string, rawFrame: string): void {
    const rawId = frameRawId(rawFrame);
    if (rawId !== undefined) {
      this.composite.set(namespace, rawId);
      this.everDelivered.add(namespace);
    }
    const wire = rewriteFrameId(rawFrame, formatCompositeCursor(this.composite));
    const accepted = this.sink.write(wire);
    this.sink.flush?.();
    if (accepted === false && this.flowing) {
      // flowing→backpressured transition: flip the flag and signal the driver to
      // pause its live upstreams (#1617). Fire ONCE per episode — subsequent
      // frames arrive with flowing already false and enqueue via ingest(), so
      // deliver() is not re-entered until resume() re-arms.
      this.flowing = false;
      this.onBackpressure?.();
    }
  }

  /** Enqueue a data frame for a backpressured namespace onto the ONE ordered
   *  pending stream (decision B / #1638). Per-namespace overflow isolation: at
   *  the bound (counting only this namespace's live data entries) DROP the frame
   *  in ISOLATION — its cursor stays at the last DELIVERED id so the upstream
   *  replays the gap on reconnect; other namespaces and control frames are
   *  untouched, and arrival order across the whole stream is preserved. */
  private enqueue(namespace: string, rawFrame: string): void {
    let live = 0;
    for (const entry of this.pending) {
      if (entry.kind === "data" && entry.namespace === namespace) live++;
    }
    if (live >= this.bufferBound) {
      this.droppedCount.set(namespace, (this.droppedCount.get(namespace) ?? 0) + 1);
      return;
    }
    this.pending.push({ kind: "data", namespace, frame: rawFrame });
  }

  private emitFocusFrame(): void {
    // decision A — a focus snapshot is ALWAYS a real frame: an absent provider
    // (or an undefined return) becomes a NAMED empty snapshot (home), never a
    // missing frame. `empty: true` marks the named-empty case for the client.
    const raw = this.focusProvider?.();
    const snapshot: FocusSnapshot & { empty?: boolean } =
      raw ?? { isHome: true, absent: false, empty: true };
    const payload = JSON.stringify({ type: "amicode.fleet.focus", ...snapshot });
    // The focus frame rides the `local` namespace. It carries no monotonic id
    // (it is a snapshot, not a resumable event) so it never advances a cursor.
    // #1638 — routed through the return-checked, order-preserving control helper.
    this.writeControl(`event: amicode.fleet.focus\ndata: ${payload}\n\n`);
  }
}
