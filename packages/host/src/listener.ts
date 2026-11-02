// The one listener. Loopback only. Bun's default idleTimeout (10 s) kills an idle event stream before its
// 15 s heartbeat, so it is disabled (H0c negative control).
import type { Handler } from "./front.ts"

export const IDLE_TIMEOUT = 0

export function listen(options: { port: number; fetch: Handler }) {
  return Bun.serve({ hostname: "127.0.0.1", port: options.port, idleTimeout: IDLE_TIMEOUT, fetch: options.fetch })
}
