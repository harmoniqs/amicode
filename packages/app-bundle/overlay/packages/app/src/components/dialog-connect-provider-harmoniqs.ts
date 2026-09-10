// Harmoniqs AI — a branded, always-present entry in the Connect Provider
// picker (amicode#962). It is deliberately NOT sourced from providers().all():
// Harmoniqs is a preset (fixed base URL/model, key routed straight to
// opencode's own auth store) that the generic key-entry flow
// (ProviderConnection in dialog-connect-provider.tsx) cannot express without
// duplicating that logic — see packages/extension/src/onboarding_panel.ts
// (amicode repo) for where writeOnboardingConfig/writeAuthApiKey/
// testConnection/classifyHarmoniqsError actually live. Clicking this entry
// hands off to that logic's own connection UI instead of rendering here.
//
// Extracted from dialog-connect-provider.tsx (mirrors dialog-custom-provider's
// split into dialog-custom-provider-form.ts) so the gating/messaging logic is
// unit-testable without rendering the picker.

import { inAmicode } from "@/utils/amicode-bridge"

export const HARMONIQS_PROVIDER_ID = "harmoniqs"
export const HARMONIQS_PROVIDER_NAME = "Harmoniqs AI"

/** The envelope this module posts when the branded row is clicked. */
export const CONNECT_HARMONIQS_PROVIDER_KIND = "connect-harmoniqs-provider"
/** The envelope the extension host acks with — the dialog closes on receipt
 *  (see useHarmoniqsProviderConnectAck). The extension's own handoff panel
 *  (Stage-0's onboarding webview, focused to just this provider) runs
 *  independently after that; this dialog has no further role. */
export const CONNECT_HARMONIQS_PROVIDER_ACK_KIND = "connect-harmoniqs-provider-ack"

type KnownProviderIds = ReadonlySet<string> | { has(id: string): boolean }

/** Whether the branded Harmoniqs row belongs in the picker right now:
 *  - only inside the extension (`inAmicode()`) — outside it there is no host
 *    to relay `connect-harmoniqs-provider` to, so a visible-but-dead entry
 *    would just confuse; and
 *  - only while the real provider hasn't already landed in the catalog some
 *    other way (a future `provider.harmoniqs` entry in opencode.json, or the
 *    generic seed mechanism tracked separately as amicode#326) — the stub
 *    must never shadow a real catalog entry. */
export function shouldShowHarmoniqsEntry(knownProviderIds: KnownProviderIds): boolean {
  return inAmicode() && !knownProviderIds.has(HARMONIQS_PROVIDER_ID)
}

/** Ask the extension host to open its own Harmoniqs connection UI. */
export function requestHarmoniqsProviderConnect(): void {
  if (typeof window === "undefined") return
  window.parent?.postMessage({ source: "amicode", kind: CONNECT_HARMONIQS_PROVIDER_KIND }, "*")
}

/** True for the extension's ack envelope — the dialog's cue to close. */
export function isHarmoniqsProviderConnectAck(data: unknown): boolean {
  if (!data || typeof data !== "object") return false
  const d = data as { source?: unknown; kind?: unknown }
  return d.source === "amicode" && d.kind === CONNECT_HARMONIQS_PROVIDER_ACK_KIND
}
