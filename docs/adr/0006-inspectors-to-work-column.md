# Inspectors move to the Work Column; the bottom panel is retired

Status: proposed (2026-08-12)

Tracking: harmoniqs/amicode#351 · Glossary update: `CONTEXT.md` (app)

The Run Inspector and Device Inspector — previously native VS Code `WebviewViewProvider` registrations in a dedicated bottom panel (`amicode-panel`) — relocate to the Work Column as dynamic SolidJS tabs. The bottom panel container and all its webview infrastructure are deleted. Data reaches the app via the existing `chat_bridge.ts` postMessage protocol, extended with typed run/device message families.

**Why:** Three problems converged. (1) The bottom panel consumed vertical space independently of the Work Column — a researcher monitoring a solve had two auxiliary surfaces open (column + panel), each competing for the editor's real estate. (2) The inspectors were session-contextual data living in a session-agnostic container — the bottom panel had no session binding, so switching sessions didn't switch inspector state. (3) The extension maintained two parallel rendering stacks (vanilla TS atoms for the panel webviews; SolidJS in the iframed app) for surfaces that belong in the same visual hierarchy — the Work Column.

**Conditions of acceptance:** The inspector tabs render all information the bottom-panel webviews showed (iterations, pulse plot, fidelity, drive lines, qubit status, metrics, actions). Tab open/close lifecycle matches the current reveal-on-event behavior. The bottom panel container no longer appears in `package.json` or at runtime. The live-solve titlebar indicator is removed — the Run Inspector tab is now the sole surface for solve status.

**Accepted costs:** ~600 lines of proven vanilla TS view code are rewritten in SolidJS — the new implementations must reach functional parity before the old ones are deleted (no phased coexistence; both renderers can't exist meaningfully). The pulse plot at 320px column width is narrower than the full-width bottom panel; fine detail (many drives, long pulses) may require horizontal scroll or a zoom interaction the old plot lacked. `session-side-panel.tsx` gains complexity (two new tab types with their message listeners and state buffers).

**Considered:** (A) iframe the existing webview HTML inside the Work Column tab (runner-up: minimal rewrite, but iframe-in-iframe with double postMessage hop and style isolation; the inspector remains a foreign body that can't use app design tokens); (B) incremental — text-only status tab first, full inspector later (rejected: temporary duplication, incomplete UX, two shipping milestones for a single conceptual move).

**Flip condition:** if the Work Column tab strip becomes too crowded (inspector tabs competing with file tabs during active development), revisit whether inspectors should be a collapsible section within a shared tab rather than top-level tabs. If VS Code gains a native "editor panel" API that lets webviews dock into the editor area without iframes, the SolidJS approach may be unnecessary — but that API doesn't exist today.
