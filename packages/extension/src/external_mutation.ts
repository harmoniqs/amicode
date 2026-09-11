import type { ExternalReservation } from "./external_mutation_transport";

/** The transport shape lets Sidebar operations preserve ordinary behavior when tracking is absent. */
export interface ExternalMutationTracker {
  prepare(sessionID: string, files: string[]): Promise<ExternalReservation | undefined>;
  commit(sessionID: string, reservation: ExternalReservation): Promise<boolean>;
  abort(sessionID: string, reservation: ExternalReservation): Promise<boolean>;
}

/** A focused panel snapshot, held only by the extension host for one operation. */
export interface MutationTrackingContext {
  sessionID: string;
  transport: ExternalMutationTracker;
  /** Host-only watcher refresh after the server confirms the reservation group. */
  onCommitted?: (sessionID: string) => Promise<void> | void;
}

async function bestEffortAbort(context: MutationTrackingContext, reservation: ExternalReservation): Promise<void> {
  try {
    await context.transport.abort(context.sessionID, reservation);
  } catch {
    // Tracking cannot turn a completed Sidebar operation into a failed one.
  }
}

/**
 * Bracket one already-authorized filesystem mutation with a session reservation.
 * Missing/rejected tracking intentionally falls through to the original mutation.
 */
export async function runTrackedMutation<T>(input: {
  tracking?: MutationTrackingContext;
  files: string[];
  mutate: () => Promise<T>;
}): Promise<T> {
  const tracking = input.tracking;
  if (!tracking) return input.mutate();

  let reservation: ExternalReservation | undefined;
  try {
    reservation = await tracking.transport.prepare(tracking.sessionID, input.files);
  } catch {
    // The server is unavailable: preserve the regular Sidebar operation untracked.
  }
  if (!reservation) return input.mutate();

  let result: T;
  try {
    result = await input.mutate();
  } catch (error) {
    await bestEffortAbort(tracking, reservation);
    throw error;
  }

  // A response can be lost after the server commits. The server retains the
  // group identifier as its idempotency key, so retry the whole group once.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (await tracking.transport.commit(tracking.sessionID, reservation)) {
        try {
          await tracking.onCommitted?.(tracking.sessionID);
        } catch {
          // A watcher refresh is advisory; a committed Sidebar mutation stays successful.
        }
        return result;
      }
    } catch {
      // Retry below, then abort only if the group never confirms committed.
    }
  }
  await bestEffortAbort(tracking, reservation);
  return result;
}
