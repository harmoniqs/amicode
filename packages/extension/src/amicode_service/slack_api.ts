// slack_api.ts — shared Slack HTTP layer, caches, target resolution, and
// message formatting (#1039). Foundation for the three Slack MCP tools (#1037).
//
// Every function that touches the network accepts an injectable `fetchImpl`
// (same pattern as probeSlack in connections.ts). slackPreCheck accepts an
// injectable readCredentialFn so tests need no filesystem.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FetchImpl = typeof globalThis.fetch

export type SlackPreCheckResult =
  | { ok: true; token: string }
  | { ok: false; reason: string; hint: string }

export type SlackResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; reason: string; hint?: string; retry_after?: number; scope?: string }

// ---------------------------------------------------------------------------
// slackPreCheck — credential gate
// ---------------------------------------------------------------------------

export function slackPreCheck(
  readCredentialFn?: () => { token: string } | undefined,
): SlackPreCheckResult {
  const cred = readCredentialFn?.()
  if (!cred) {
    return { ok: false, reason: "not_connected", hint: "Connect Slack in Settings > Connections" }
  }
  return { ok: true, token: cred.token }
}

// ---------------------------------------------------------------------------
// slackFetch — HTTP wrapper
// ---------------------------------------------------------------------------

export async function slackFetch(
  token: string,
  method: string,
  params: Record<string, string>,
  fetchImpl: FetchImpl = globalThis.fetch,
): Promise<SlackResult> {
  const url = `https://slack.com/api/${method}`
  const body = new URLSearchParams(params).toString()
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    })
  } catch {
    return { ok: false, reason: "network_error", hint: "Could not reach Slack API" }
  }
  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get("retry-after") ?? "30", 10)
    return { ok: false, reason: "rate_limited", hint: `Rate limited — retry after ${retryAfter}s`, retry_after: retryAfter }
  }
  let data: Record<string, unknown>
  try {
    data = (await response.json()) as Record<string, unknown>
  } catch {
    return { ok: false, reason: "invalid_response", hint: "Slack returned non-JSON" }
  }
  if (data.ok === true) {
    return data as SlackResult
  }
  const error = String(data.error ?? "unknown_error")
  if (error === "invalid_auth" || error === "token_revoked" || error === "account_inactive") {
    return { ok: false, reason: "token_revoked", hint: "Reconnect Slack in Settings > Connections" }
  }
  if (error === "missing_scope") {
    const scope = String(data.needed ?? "")
    return { ok: false, reason: "missing_scope", hint: `Missing scope: ${scope}`, scope }
  }
  return { ok: false, reason: error, hint: `Slack API error: ${error}` }
}

// ---------------------------------------------------------------------------
// UserCache — lazy user-id → display-name
// ---------------------------------------------------------------------------

export class UserCache {
  private cache = new Map<string, string>()
  private token: string
  private fetchFn: FetchImpl

  constructor(token: string, fetchImpl: FetchImpl = globalThis.fetch) {
    this.token = token
    this.fetchFn = fetchImpl
  }

  async resolve(userId: string): Promise<string> {
    if (this.cache.has(userId)) return this.cache.get(userId)!
    const result = await slackFetch(this.token, "users.info", { user: userId }, this.fetchFn)
    if (result.ok) {
      const user = (result as Record<string, unknown>).user as Record<string, unknown> | undefined
      const profile = user?.profile as Record<string, unknown> | undefined
      const name =
        (typeof profile?.display_name === "string" && profile.display_name !== "" ? profile.display_name : undefined) ??
        (typeof user?.real_name === "string" && user.real_name !== "" ? user.real_name : undefined) ??
        (typeof user?.name === "string" ? user.name : userId)
      this.cache.set(userId, name)
      return name
    }
    this.cache.set(userId, userId)
    return userId
  }

  /** Bulk-seed from a users.list response (avoids per-user fetches). */
  seed(members: Array<{ id: string; name: string; real_name?: string; profile?: { display_name?: string } }>): void {
    for (const m of members) {
      const name = m.profile?.display_name || m.real_name || m.name
      this.cache.set(m.id, name)
    }
  }

  has(userId: string): boolean {
    return this.cache.has(userId)
  }
}

// ---------------------------------------------------------------------------
// ChannelCache — lazy channel-name → channel-id
// ---------------------------------------------------------------------------

export class ChannelCache {
  private nameToId = new Map<string, string>()
  private loaded = false
  private token: string
  private fetchFn: FetchImpl

  constructor(token: string, fetchImpl: FetchImpl = globalThis.fetch) {
    this.token = token
    this.fetchFn = fetchImpl
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    const result = await slackFetch(
      this.token,
      "conversations.list",
      { types: "public_channel,private_channel", limit: "200" },
      this.fetchFn,
    )
    if (result.ok) {
      const channels = (result as Record<string, unknown>).channels as
        | Array<{ id: string; name: string }>
        | undefined
      if (channels) {
        for (const ch of channels) {
          this.nameToId.set(ch.name, ch.id)
        }
      }
    }
    this.loaded = true
  }

  async resolve(channelName: string): Promise<string | undefined> {
    await this.load()
    return this.nameToId.get(channelName)
  }

  /** Force reload on next resolve. */
  invalidate(): void {
    this.loaded = false
    this.nameToId.clear()
  }
}

// ---------------------------------------------------------------------------
// resolveTarget — accept #channel, @user, raw ID, "dms"
// ---------------------------------------------------------------------------

export async function resolveTarget(
  token: string,
  target: string,
  caches: { users: UserCache; channels: ChannelCache },
  fetchImpl: FetchImpl = globalThis.fetch,
): Promise<SlackResult<{ channel_id?: string; channels?: Array<{ id: string; name: string; user?: string }> }>> {
  const trimmed = target.trim()

  // #channel
  if (trimmed.startsWith("#")) {
    const name = trimmed.slice(1)
    const id = await caches.channels.resolve(name)
    if (id) return { ok: true, channel_id: id }
    return { ok: false, reason: "channel_not_found", hint: `Channel #${name} not found` }
  }

  // @user → open DM
  if (trimmed.startsWith("@")) {
    const handle = trimmed.slice(1)
    // Look up user by name — we need to do a users.list first
    const listResult = await slackFetch(token, "users.list", { limit: "200" }, fetchImpl)
    if (!listResult.ok) return listResult as SlackResult
    const members = (listResult as Record<string, unknown>).members as
      | Array<{ id: string; name: string; real_name?: string; profile?: { display_name?: string } }>
      | undefined
    const user = members?.find(
      (m) => m.name === handle || m.profile?.display_name?.toLowerCase() === handle.toLowerCase(),
    )
    if (!user) return { ok: false, reason: "user_not_found", hint: `User @${handle} not found` }
    caches.users.seed(members ?? [])
    const dmResult = await slackFetch(token, "conversations.open", { users: user.id }, fetchImpl)
    if (!dmResult.ok) return dmResult as SlackResult
    const channel = (dmResult as Record<string, unknown>).channel as { id: string } | undefined
    if (channel) return { ok: true, channel_id: channel.id }
    return { ok: false, reason: "dm_open_failed", hint: `Could not open DM with @${handle}` }
  }

  // "dms" — list all DM channels
  if (trimmed.toLowerCase() === "dms") {
    const result = await slackFetch(token, "conversations.list", { types: "im", limit: "200" }, fetchImpl)
    if (!result.ok) return result as SlackResult
    const channels = (result as Record<string, unknown>).channels as
      | Array<{ id: string; name: string; user?: string; is_im?: boolean }>
      | undefined
    const dms = (channels ?? []).filter((ch) => ch.is_im)
    return { ok: true, channels: dms.map((ch) => ({ id: ch.id, name: ch.name ?? ch.id, user: ch.user })) }
  }

  // Raw channel ID (C/D/G prefix)
  if (/^[CDG][A-Z0-9]+$/.test(trimmed)) {
    return { ok: true, channel_id: trimmed }
  }

  return { ok: false, reason: "invalid_target", hint: `Cannot resolve target "${trimmed}" — use #channel, @user, a channel ID, or "dms"` }
}

// ---------------------------------------------------------------------------
// formatMessages — format raw Slack messages to readable text
// ---------------------------------------------------------------------------

function formatTimestamp(ts: string): string {
  const epoch = parseFloat(ts) * 1000
  const d = new Date(epoch)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export async function formatMessages(
  messages: Array<Record<string, unknown>>,
  userCache: UserCache,
  fetchImpl?: FetchImpl,
): Promise<string> {
  const lines: string[] = []
  for (const msg of messages) {
    const ts = typeof msg.ts === "string" ? msg.ts : "0"
    const userId = typeof msg.user === "string" ? msg.user : undefined
    const sender = userId ? await userCache.resolve(userId) : "unknown"
    let text = typeof msg.text === "string" ? msg.text : ""

    // Resolve <@UXXXXXX> user mentions inline
    const mentionRe = /<@(U[A-Z0-9]+)>/g
    const mentions = [...text.matchAll(mentionRe)]
    for (const match of mentions) {
      const name = await userCache.resolve(match[1])
      text = text.replace(match[0], `@${name}`)
    }

    const time = formatTimestamp(ts)
    let line = `[${time}] ${sender}: ${text}`

    // Append file info
    const files = msg.files as Array<{ name?: string; mimetype?: string; url_private?: string }> | undefined
    if (files && files.length > 0) {
      const fileDescs = files.map((f) => {
        if (f.mimetype?.startsWith("image/")) return `[image: ${f.name ?? "unnamed"}]`
        return `[file: ${f.name ?? "unnamed"}]`
      })
      line += " " + fileDescs.join(" ")
    }

    // Append attachment info
    const attachments = msg.attachments as Array<{ text?: string; fallback?: string; title?: string }> | undefined
    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        const attText = att.text ?? att.fallback ?? att.title ?? ""
        if (attText) line += `\n    attachment: ${attText}`
      }
    }

    // Thread indicator
    const replyCount = msg.reply_count
    if (typeof replyCount === "number" && replyCount > 0) {
      line += ` (${replyCount} ${replyCount === 1 ? "reply" : "replies"})`
    }

    lines.push(line)
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// resolveHandles — @handle → <@UID>
// ---------------------------------------------------------------------------

export async function resolveHandles(
  text: string,
  userCache: UserCache,
  fetchImpl?: FetchImpl,
): Promise<string> {
  // Don't re-resolve already-encoded Slack mentions
  const handleRe = /(?<![<])@(\w[\w.-]*)/g
  const matches = [...text.matchAll(handleRe)]
  if (matches.length === 0) return text

  // We need a name→id reverse lookup. Fetch users.list if we haven't yet.
  let members: Array<{ id: string; name: string; real_name?: string; profile?: { display_name?: string } }> = []
  if (fetchImpl) {
    const result = await slackFetch(userCache["token"], "users.list", { limit: "200" }, fetchImpl)
    if (result.ok) {
      members = (result as Record<string, unknown>).members as typeof members ?? []
      userCache.seed(members)
    }
  }

  let result = text
  for (const match of matches) {
    const handle = match[1]
    const user = members.find(
      (m) => m.name === handle || m.profile?.display_name?.toLowerCase() === handle.toLowerCase(),
    )
    if (user) {
      result = result.replace(match[0], `<@${user.id}>`)
    }
    // Unknown handles → leave as literal text (per spec)
  }
  return result
}
