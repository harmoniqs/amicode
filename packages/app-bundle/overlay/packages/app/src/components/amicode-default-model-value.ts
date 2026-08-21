// Pure "providerID/modelID" <-> ModelKey helpers for the dashboard default-model
// control. Split out of amicode-default-model.tsx so they're unit-testable
// without evaluating the SolidJS component (which touches client-only context).

/** "providerID/modelID". modelID may itself contain "/", so callers split on the first. */
export function formatModelValue(key: { providerID: string; modelID: string }): string {
  return `${key.providerID}/${key.modelID}`
}

/** Inverse of formatModelValue; null on a malformed/empty value. Splits on the
 *  FIRST slash so a model id containing slashes (e.g. openrouter/meta-llama/…)
 *  round-trips. */
export function parseModelValue(value: string): { providerID: string; modelID: string } | null {
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return null
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) }
}
