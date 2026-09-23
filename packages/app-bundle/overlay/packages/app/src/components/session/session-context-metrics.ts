import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2/client"

type Provider = {
  id: string
  name?: string
  models: Record<string, Model | undefined>
}

type Model = {
  name?: string
  limit: {
    context: number
  }
}

type Context = {
  message: AssistantMessage
  provider?: Provider
  model?: Model
  providerLabel: string
  modelLabel: string
  limit: number | undefined
  input: number
  total: number
  usage: number | null
}

const tokenTotal = (msg: AssistantMessage) => {
  // #1311: messages can carry absent/partial token usage (streaming turns,
  // snapshot-trimmed seeds, providers that don't report cache or reasoning).
  // The ungated read threw "Cannot read properties of undefined (reading
  // 'input')" and the route boundary turned ONE partial-usage row into the
  // frozen-hold mask for the whole panel. Partial usage is not an error.
  const t = (msg as { tokens?: Record<string, number | Record<string, number>> }).tokens
  if (!t) return 0
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
  const cacheScore = (cache: number | Record<string, number> | undefined) =>
    typeof cache === "number" ? num(cache) : num(cache?.read) + num(cache?.write)
  return num(t.input) + num(t.output) + num(t.reasoning) + cacheScore(t.cache)
}

const lastAssistantWithTokens = (messages: Message[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "assistant") continue
    if (tokenTotal(msg) <= 0) continue
    return msg
  }
}

const build = (messages: Message[] = [], providers: Provider[] = []): Context | undefined => {
  const message = lastAssistantWithTokens(messages)
  if (!message) return undefined

  const provider = providers.find((item) => item.id === message.providerID)
  const model = provider?.models[message.modelID]
  const limit = model?.limit.context
  const total = tokenTotal(message)

  return {
    message,
    provider,
    model,
    providerLabel: provider?.name ?? message.providerID,
    modelLabel: model?.name ?? message.modelID,
    limit,
    input: tokenTotal(message) > 0 ? ((message.tokens as unknown as Record<string, number>).input ?? 0) : 0,
    total,
    usage: limit ? Math.round((total / limit) * 100) : null,
  }
}

export function getSessionContext(messages: Message[] = [], providers: Provider[] = []) {
  return build(messages, providers)
}
