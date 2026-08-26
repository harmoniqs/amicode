/**
 * Determines the badge text shown in the titlebar channel indicator.
 *
 * - Developer mode ON → "DEV" (regardless of build channel)
 * - Developer mode OFF, beta/dev channel → "BETA"
 * - Developer mode OFF, prod channel → null (no badge)
 */
export function channelBadgeText(channel: string, developerEnabled: boolean): "DEV" | "BETA" | null {
  if (developerEnabled) return "DEV"
  if (["beta", "dev"].includes(channel)) return "BETA"
  return null
}
