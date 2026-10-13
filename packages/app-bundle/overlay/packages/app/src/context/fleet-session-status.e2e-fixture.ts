// amicode#1766 — the END-TO-END contract fixture binding the two halves of the
// fleet re-seed. Import-free on purpose: it is loaded by BOTH the service's
// vitest end-to-end test (which asserts the REAL GET /amicode/fleet/session-status
// handler, driven against a stubbed peer owner, answers EXACTLY
// FLEET_STATUS_E2E_RESPONSE) and the app's bun end-to-end test (which feeds this
// same response through the app's parse + reconcile into the store). If either
// side's shape moves, one of the two tests goes red.
//
// Session ids are the engine's raw ids end to end — the id the app pins is the
// owner-map key and the key in the owner's own status answer.

export const E2E = {
  localMachine: "e2e-laptop",
  peerMachine: "e2e-studio",
  localDirectory: "/Users/jj/harmoniqs/local-e2e",
  peerDirectory: "/Users/jj/harmoniqs/amicode",
  /** reported busy by the stubbed peer owner, in its own directory */
  peerBusySession: "ses_e2e_peer_busy",
  /** in the same peer directory, absent from the owner's answer → idle */
  peerQuietSession: "ses_e2e_peer_quiet",
  /** a local session, absent from the local engine's answer → idle */
  localSession: "ses_e2e_local",
  /** pinned, but unknown to the service's owner map → omitted + unresolved */
  unknownSession: "ses_e2e_unknown",
  /** the app's pinned ids, the viewed (peer busy) session first */
  pinnedIds: ["ses_e2e_peer_busy", "ses_e2e_peer_quiet", "ses_e2e_local", "ses_e2e_unknown"],
} as const

export const FLEET_STATUS_E2E_RESPONSE = {
  ok: true,
  statuses: {
    ses_e2e_peer_busy: { type: "busy" },
    ses_e2e_peer_quiet: { type: "idle" },
    ses_e2e_local: { type: "idle" },
  },
  sources: {
    "e2e-studio": { present: true, directories: { "/Users/jj/harmoniqs/amicode": { ok: true, sessions: 2 } } },
    "e2e-laptop": { present: true, directories: { "/Users/jj/harmoniqs/local-e2e": { ok: true, sessions: 1 } } },
  },
  unresolved: [{ id: "ses_e2e_unknown", reason: "unknown" }],
}
