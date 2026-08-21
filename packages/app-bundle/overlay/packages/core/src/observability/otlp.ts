import { Layer, Effect, Schedule, Duration } from "effect"
import { OtlpLogger } from "effect/unstable/observability"
import type { Context } from "@opentelemetry/api"
import type { ReadableSpan, Span, SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-base"
import { Flag } from "../flag/flag"
import { InstallationChannel, InstallationVersion } from "../installation/version"
import { runID } from "./shared"

const endpoint = Flag.OTEL_EXPORTER_OTLP_ENDPOINT

const headers = Flag.OTEL_EXPORTER_OTLP_HEADERS
  ? Flag.OTEL_EXPORTER_OTLP_HEADERS.split(",").reduce(
      (acc, entry) => {
        const [key, ...value] = entry.split("=")
        acc[key] = value.join("=")
        return acc
      },
      {} as Record<string, string>,
    )
  : undefined

function resourceAttributes() {
  const value = process.env.OTEL_RESOURCE_ATTRIBUTES
  if (!value) return {}
  try {
    return Object.fromEntries(
      value.split(",").map((entry) => {
        const index = entry.indexOf("=")
        if (index < 1) throw new Error("Invalid OTEL_RESOURCE_ATTRIBUTES entry")
        return [decodeURIComponent(entry.slice(0, index)), decodeURIComponent(entry.slice(index + 1))]
      }),
    )
  } catch {
    return {}
  }
}

export function resource(): { serviceName: string; serviceVersion: string; attributes: Record<string, string> } {
  return {
    serviceName: "opencode",
    serviceVersion: InstallationVersion,
    attributes: {
      ...resourceAttributes(),
      "deployment.environment.name": InstallationChannel,
      "opencode.client": Flag.OPENCODE_CLIENT,
      "opencode.run": runID,
      "service.instance.id": runID,
    },
  }
}

// Rate limiting configuration to prevent AWS CloudFront bans
const TELEMETRY_BATCH_SIZE = 100
const TELEMETRY_BATCH_DELAY_MS = 5000
const TELEMETRY_MAX_QUEUE_SIZE = 1000
const TELEMETRY_EXPORT_RETRIES = 3

class RateLimitedSpanProcessor implements SpanProcessor {
  private spans: ReadableSpan[] = []
  private timer: NodeJS.Timeout | undefined
  private exporting: Promise<void> | undefined
  private nextExportAt = 0
  private shutdownPromise: Promise<void> | undefined
  private isShutdown = false

  constructor(private readonly exporter: SpanExporter) {}

  onStart(_span: Span, _parentContext: Context): void {}

  onEnd(span: ReadableSpan): void {
    if (this.isShutdown || this.spans.length >= TELEMETRY_MAX_QUEUE_SIZE) return
    this.spans.push(span)
    this.scheduleExport()
  }

  async forceFlush(): Promise<void> {
    this.clearTimer()
    while (this.exporting || this.spans.length > 0) {
      if (this.exporting) {
        await this.exporting
        continue
      }
      await this.exportWithRetry(this.spans.splice(0, TELEMETRY_BATCH_SIZE))
    }
    await this.exporter.forceFlush?.()
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.shutdownProcessor()
    return this.shutdownPromise
  }

  private async shutdownProcessor(): Promise<void> {
    this.isShutdown = true
    try {
      await this.forceFlush()
    } finally {
      await this.exporter.shutdown()
    }
  }

  private scheduleExport(): void {
    if (this.isShutdown || this.exporting || this.timer || this.spans.length === 0) return
    const delay = this.spans.length >= TELEMETRY_BATCH_SIZE ? Math.max(0, this.nextExportAt - Date.now()) : TELEMETRY_BATCH_DELAY_MS
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.exportNextBatch()
    }, delay)
  }

  private exportNextBatch(): void {
    if (this.exporting || this.spans.length === 0) return
    const batch = this.spans.splice(0, TELEMETRY_BATCH_SIZE)
    const exporting = this.exportWithRetry(batch)
    this.exporting = exporting
    void exporting.catch((error) => console.warn("Telemetry export failed after retries:", error))
    void exporting
      .finally(() => {
        this.exporting = undefined
        this.nextExportAt = Date.now() + TELEMETRY_BATCH_DELAY_MS
        this.scheduleExport()
      })
      .catch(() => undefined)
  }

  private async exportWithRetry(spans: ReadableSpan[]): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.export(spans)
        return
      } catch (error) {
        if (attempt >= TELEMETRY_EXPORT_RETRIES) throw error
        await new Promise<void>((resolve) => setTimeout(resolve, 1000 * 2 ** attempt))
      }
    }
  }

  private export(spans: ReadableSpan[]): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.exporter.export(spans, (result) => {
          if (result.code === 0) {
            resolve()
            return
          }
          reject(result.error ?? new Error("Telemetry export failed"))
        })
      } catch (error) {
        reject(error)
      }
    })
  }

  private clearTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = undefined
  }
}

export function loggers() {
  // Disable telemetry if flag is set
  if (Flag.OPENCODE_DISABLE_TELEMETRY || !endpoint) return []
  return [OtlpLogger.make({ url: `${endpoint}/v1/logs`, resource: resource(), headers })]
}

export async function tracingLayer() {
  // Disable telemetry if flag is set
  if (Flag.OPENCODE_DISABLE_TELEMETRY || !endpoint) return Layer.empty
  const NodeSdk = await import("@effect/opentelemetry/NodeSdk")
  const OTLP = await import("@opentelemetry/exporter-trace-otlp-http")
  const { AsyncLocalStorageContextManager } = await import("@opentelemetry/context-async-hooks")
  const { context } = await import("@opentelemetry/api")

  // The Effect Node SDK does not register a global context manager, but the AI SDK uses it to parent spans.
  const manager = new AsyncLocalStorageContextManager()
  manager.enable()
  context.setGlobalContextManager(manager)

  const exporter = new OTLP.OTLPTraceExporter({
    url: `${endpoint}/v1/traces`,
    headers,
    timeoutMillis: 30000, // 30 second timeout
  })

  const processor = new RateLimitedSpanProcessor(exporter)

  return NodeSdk.layer(() => ({
    resource: resource(),
    spanProcessor: processor,
  }))
}

export * as Otlp from "./otlp"
