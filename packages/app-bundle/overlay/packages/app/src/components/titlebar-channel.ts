/**
 * Determines the badge text shown in the titlebar channel indicator.
 *
 * - Developer mode ON → "DEV" (regardless of build channel)
 * - Developer mode OFF, dev channel → "DEV" (internal dev builds)
 * - Developer mode OFF, beta channel → "BETA" (store/beta releases)
 * - Developer mode OFF, prod channel → null (no badge)
 */
export function channelBadgeText(channel: string, developerEnabled: boolean): "DEV" | "BETA" | null {
  if (developerEnabled) return "DEV"
  if (channel === "dev") return "DEV"
  if (channel === "beta") return "BETA"
  return null
}
