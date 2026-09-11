/// <reference lib="webworker" />

import { ShikiStreamTokenizer } from "@shikijs/stream"
import {
  bundledLanguages,
  createHighlighter,
  getTokenStyleObject,
  stringifyTokenStyle,
  type BundledLanguage,
  type ThemedToken,
} from "shiki"
import type { MarkdownToken, MarkdownWorkerRequest, MarkdownWorkerResponse } from "./markdown-worker-protocol"
import { createLatestWorkerQueue } from "./markdown-worker-queue"

type Stream = {
  language: string
  source: string
  tokenizer: ShikiStreamTokenizer
}

const streams = new Map<string, Stream>()
let highlighter: ReturnType<typeof createHighlighter> | undefined
let currentThemeName = "OpenCode"
const queue = createLatestWorkerQueue<Extract<MarkdownWorkerRequest, { type: "highlight" }>>({
  run: highlight,
  supersede: (request) => post({ type: "superseded", id: request.id, key: request.key }),
  dispose: (key) => void streams.delete(key),
})

self.onmessage = (event: MessageEvent<MarkdownWorkerRequest>) => {
  if (event.data.type === "init") {
    highlighter ??= createHighlighter({ themes: [event.data.theme], langs: [] })
    return
  }
  if (event.data.type === "dispose") {
    queue.dispose(event.data.key)
    return
  }
  // Theme update from the extension bridge (via shiki-theme-state)
  if ((event.data as any).type === "theme-update") {
    const msg = event.data as any
    if (typeof msg.theme === "object" && highlighter) {
      highlighter.then((instance) => {
        if (instance) instance.loadTheme(msg.theme)
      })
    }
    if (typeof msg.name === "string") currentThemeName = msg.name
    // Clear all streams so they pick up the new theme on next highlight
    streams.clear()
    return
  }

  queue.highlight(event.data)
}

async function highlight(request: Extract<MarkdownWorkerRequest, { type: "highlight" }>) {
  try {
    const instance = await highlighter
    if (!instance) throw new Error("Shiki worker is not initialized")
    const language = request.language in bundledLanguages ? request.language : "text"
    if (!instance.getLoadedLanguages().includes(language))
      await instance.loadLanguage(bundledLanguages[language as BundledLanguage])

    if (request.complete) {
      const result = instance.codeToTokens(request.text, { lang: language as BundledLanguage, theme: currentThemeName })
      streams.delete(request.key)
      post({
        type: "highlight",
        id: request.id,
        key: request.key,
        reset: true,
        stable: result.tokens
          .flatMap((line, index) =>
            index === result.tokens.length - 1 ? line : [...line, { content: "\n", offset: 0 }],
          )
          .map(token),
        unstable: [],
      })
      return
    }

    const previous = streams.get(request.key)
    const reset = !previous || previous.language !== language || !request.text.startsWith(previous.source)
    const stream = reset
      ? {
          language,
          source: "",
          tokenizer: new ShikiStreamTokenizer({ highlighter: instance, lang: language, theme: currentThemeName }),
        }
      : previous
    const result = await stream.tokenizer.enqueue(request.text.slice(stream.source.length))
    stream.source = request.text
    streams.set(request.key, stream)
    post({
      type: "highlight",
      id: request.id,
      key: request.key,
      reset,
      stable: result.stable.filter((token) => token.content.length > 0).map(token),
      unstable: result.unstable.filter((token) => token.content.length > 0).map(token),
    })
  } catch (error) {
    post({
      type: "error",
      id: request.id,
      key: request.key,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

function post(response: MarkdownWorkerResponse) {
  self.postMessage(response)
}

function token(value: ThemedToken): MarkdownToken {
  return [value.content, stringifyTokenStyle(value.htmlStyle ?? getTokenStyleObject(value))]
}
