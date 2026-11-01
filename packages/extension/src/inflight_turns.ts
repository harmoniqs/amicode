// ============================================================================
// IN-FLIGHT TURN TRACKING (#1571) — the real hasInflightTurns().
//
// The stale-engine restart (restartAdoptedEngine) reloads the window and kills
// the survivor server; a click used to stand in for "nobody is mid-turn".
// This module is that safety check: a passive sink over the engine's own
// session.status frames (the same stream the followed-session watcher rides),
// plus a /session/status probe for turns that began BEFORE this window adopted
// the survivor (their busy frame was never observed).
//
// No vscode import — pure and unit-testable.
// ============================================================================
import type { OpencodeStreamEvent } from "./sse_client";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class InflightTurnTracker {
  /** Sessions whose last observed status is non-idle (busy | retry). */
  private readonly active = new Set<string>();
  /** sessionID → max status seq seen (#1636): stale/replayed frames are dropped. */
  private readonly statusSeq = new Map<string, number>();
  private readonly quiesceListeners = new Set<() => void>();

  /** Observe one parsed stream event. Never throws. */
  observe(event: OpencodeStreamEvent): void {
    const props = event.properties ?? {};
    if (event.type === "session.status") {
      this.onStatus(props);
    } else if (event.type === "session.deleted") {
      const info = props.info;
      const id = isRecord(info) && typeof info.id === "string" ? info.id : typeof props.sessionID === "string" ? props.sessionID : "";
      if (id !== "") this.close(id);
    }
  }

  hasInflightTurns(): boolean {
    return this.active.size > 0;
  }

  /** Fired each time the tracker transitions from "turns in flight" to none. */
  onQuiesce(listener: () => void): () => void {
    this.quiesceListeners.add(listener);
    return () => { this.quiesceListeners.delete(listener); };
  }

  private onStatus(props: Record<string, unknown>): void {
    const sessionID = typeof props.sessionID === "string" ? props.sessionID : "";
    const status = isRecord(props.status) ? props.status : undefined;
    if (sessionID === "" || !status) return;
    const seq = typeof props.seq === "number" ? props.seq : undefined;
    if (seq !== undefined) {
      const seen = this.statusSeq.get(sessionID);
      if (seen !== undefined && seq <= seen) return;
      this.statusSeq.set(sessionID, seq);
    }
    const type = typeof status.type === "string" ? status.type : "idle";
    if (type === "idle") this.close(sessionID);
    else this.active.add(sessionID); // busy | retry — the turn is still in flight
  }

  private close(sessionID: string): void {
    if (!this.active.delete(sessionID)) return;
    if (this.active.size > 0) return;
    for (const listener of [...this.quiesceListeners]) {
      try { listener(); } catch { /* a broken listener never blocks the rest */ }
    }
  }
}

export interface ProbeBusySessionsOpts {
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Count non-idle sessions via the engine's `GET /session/status` map.
 *  Returns undefined when the answer is unknown (network error, non-2xx,
 *  malformed body) — callers decide how conservative to be. */
export async function probeBusySessions(
  baseUrl: string,
  opts: ProbeBusySessionsOpts = {},
): Promise<number | undefined> {
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const url = new URL("/session/status", baseUrl).toString();
    const res = await doFetch(url, {
      headers: opts.headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 4000),
    });
    if (!res.ok) return undefined;
    const body: unknown = await res.json();
    if (!isRecord(body)) return undefined;
    let n = 0;
    for (const v of Object.values(body)) {
      if (!isRecord(v) || v.type !== "idle") n++;
    }
    return n;
  } catch {
    return undefined;
  }
}
