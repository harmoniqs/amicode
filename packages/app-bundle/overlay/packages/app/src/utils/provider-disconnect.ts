export type DisconnectPlan = "disable" | "remove-auth" | "none"

export function disconnectPlan(input: {
  source: "env" | "api" | "config" | "custom" | undefined
  configCustom: boolean
  protocol: "v1" | "v2" | undefined
}): DisconnectPlan {
  if (input.source === "env") return "none"
  if (input.configCustom || input.source === "config") {
    // Config-sourced credentials live in the config file, not the auth store —
    // removing auth entries is a no-op for them; only disabled_providers drops them.
    return input.protocol === "v1" ? "disable" : "none"
  }
  return "remove-auth"
}
