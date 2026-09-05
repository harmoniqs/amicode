// D3 client-side (spec spec-20260905-045114-session-device-lifecycle, revised
// placement), issue #817: at boot the client checks the SERVER-REPORTED
// version against the release channel and records the outcome. The check
// fails OPEN when the channel is unreachable, but records a distinct outcome
// — `parity-ok | parity-drift | channel-unreachable` — so an assertion that
// never ran is never mistaken for one that passed (the lagging-hub incident:
// a pre-amicode.21 hub ran two days while fixed releases existed). Pure and
// dependency-free so it unit-tests headless; the wiring supplies the channel.

export type ParityOutcome = "parity-ok" | "parity-drift" | "channel-unreachable"

export type ParityRecord = {
  outcome: ParityOutcome
  /** The hub's self-reported version, when it reported one. */
  serverVersion?: string
  /** The channel's latest release version, when reachable. */
  channelVersion?: string
  /** What went wrong, for channel-unreachable. */
  detail?: string
}

const releaseIdentity = (version: string | undefined) => version?.trim().replace(/^v/, "") ?? ""

/** The comparison core: both sides must be present and equal for parity-ok.
 *  Anything less — an unreported server version, an unreleasable channel — is
 *  drift, never an assumed ok. */
export function parityOutcome(input: { serverVersion?: string; channelVersion?: string }): ParityOutcome {
  const server = releaseIdentity(input.serverVersion)
  const channel = releaseIdentity(input.channelVersion)
  if (!server || !channel) return "parity-drift"
  return server === channel ? "parity-ok" : "parity-drift"
}

/** The channel is injectable: it resolves to the latest release version the
 *  client should expect, or throws when unreachable. */
export async function checkParity(input: {
  serverVersion?: string
  channel: () => Promise<string>
}): Promise<ParityRecord> {
  let channelVersion: string | undefined
  try {
    channelVersion = await input.channel()
  } catch (error) {
    return {
      outcome: "channel-unreachable",
      serverVersion: input.serverVersion,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
  return {
    outcome: parityOutcome({ serverVersion: input.serverVersion, channelVersion }),
    serverVersion: input.serverVersion,
    channelVersion,
  }
}

/** The release channel the overlay boots against: canonical opencode's public
 *  GitHub releases (the overlay's upstream base). Public and tokenless; a
 *  non-200 or tagless response throws so the record stays honest. */
export async function fetchCanonicalReleaseChannel(fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl("https://api.github.com/repos/anomalyco/opencode/releases/latest", {
    headers: { Accept: "application/vnd.github+json" },
  })
  if (!response.ok) throw new Error(`channel HTTP ${response.status}`)
  const body = (await response.json()) as { tag_name?: string }
  const tag = body.tag_name
  if (!tag) throw new Error("channel response carried no tag_name")
  return tag
}

/** The boot assertion (D3): check the server-reported version against the
 *  release channel and LOG the three-outcome record. Surfaced, never a gate —
 *  enforcement of upgrading is advisory for solo users; the check is not
 *  optional. */
export async function recordBootParity(input: {
  serverVersion?: string
  fetcher: typeof fetch
  log?: (line: string) => void
}): Promise<ParityRecord> {
  const log = input.log ?? ((line: string) => console.info(`[parity] ${line}`))
  const record = await checkParity({
    serverVersion: input.serverVersion,
    channel: () => fetchCanonicalReleaseChannel(input.fetcher),
  })
  const parts = [record.outcome]
  if (record.detail) parts.push(`(${record.detail})`)
  if (record.serverVersion) parts.push(`server=${record.serverVersion}`)
  if (record.channelVersion) parts.push(`channel=${record.channelVersion}`)
  log(parts.join(" "))
  return record
}
