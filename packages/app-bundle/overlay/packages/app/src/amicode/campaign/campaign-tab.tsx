// amicode#694: the Campaign tab — the Work Column's full-ledger drill-down
// beside the campaign-digest home tile (#690). Renders the ENTIRE campaign
// ledger from the existing routes (#662): the objective, the complete verdict
// table (unit → status → evidence), the blocked queue with reasons, and the
// §8 loop log. Data path: GET /amicode/campaigns → pickCampaign (the digest's
// newest-ACTIVE rule) → GET /amicode/campaign?slug= → campaignLedgerModel.
//
// Discipline: Solid JSX only (text auto-escapes; raw HTML injection is out of
// contract), theme-token utility classes, an empty state for every level (no
// campaigns → how one starts; fetch failure → readable message; content-less
// ledger → says so).
import { For, Show, createMemo, createResource } from "solid-js"
import { useServer } from "@/context/server"
import { amicodeGet } from "@/utils/amicode-fetch"
import {
  campaignLedgerModel,
  pickCampaign,
  statusTone,
  type CampaignDetailPayload,
  type CampaignSummary,
  type StatusTone,
} from "./campaign-tab-model"

const toneClass: Record<StatusTone, string> = {
  success: "text-v2-state-fg-success border-v2-state-border-success",
  danger: "text-v2-state-fg-danger border-v2-state-border-danger",
  neutral: "text-text-weak border-border-weak-base",
}

const SectionLabel = (props: { text: string; tone?: StatusTone; note?: string }) => (
  <div class="flex items-baseline gap-2 min-w-0">
    <div class="text-10-medium uppercase tracking-[0.1em] text-text-faint shrink-0">{props.text}</div>
    <Show when={props.note}>
      <div class="text-10-regular text-text-faint truncate">{props.note}</div>
    </Show>
  </div>
)

const StatusChip = (props: { status: string }) => (
  <span
    class={`inline-block max-w-full truncate rounded-full border px-2 py-px text-10-medium ${toneClass[statusTone(props.status)]}`}
  >
    {props.status}
  </span>
)

export function CampaignTabContent() {
  const server = useServer()

  const [lists, { refetch }] = createResource(
    () => server.current,
    async (conn) => {
      const raw = (await amicodeGet(conn, "/amicode/campaigns")) as
        | { ok: boolean; campaigns?: CampaignSummary[] }
        | undefined
      return raw?.ok ? (raw.campaigns ?? []) : []
    },
  )

  const picked = createMemo(() => pickCampaign(lists() ?? []))

  const [detail] = createResource(
    () => picked()?.slug,
    async (slug) => {
      const conn = server.current
      if (!conn || !slug) return undefined
      const raw = (await amicodeGet(conn, `/amicode/campaign?slug=${encodeURIComponent(slug)}`)) as
        | { ok: boolean; campaign?: CampaignDetailPayload }
        | undefined
      return raw?.ok ? raw.campaign : undefined
    },
  )

  const model = createMemo(() => campaignLedgerModel(detail()))

  // The loop log's discriminated union, narrowed once — Show's keyed children
  // get the narrowed shape (the §8 tail renders as a table or a text log).
  const loopTable = createMemo(() => {
    const log = model().loopLog
    return log.kind === "table" && log.rows.length > 0 ? log.rows : undefined
  })
  const loopText = createMemo(() => {
    const log = model().loopLog
    return log.kind === "text" && log.lines.length > 0 ? log.lines : undefined
  })

  return (
    <div class="relative pt-2 flex-1 min-h-0 overflow-hidden flex flex-col gap-3 p-3">
      <Show
        when={!lists.error}
        fallback={
          <div class="flex-1 flex flex-col items-center justify-center text-center gap-3">
            <div class="text-12-regular text-text-weak max-w-56">
              The campaign list couldn't load — the Amicode service may be restarting.
            </div>
            <button
              class="text-11-medium text-text-base border border-border-weak-base rounded-md px-2.5 py-1 hover:bg-background-stronger transition-colors"
              onClick={() => void refetch()}
            >
              Retry
            </button>
          </div>
        }
      >
        <Show
          when={(lists() ?? []).length > 0}
          fallback={
            <div class="flex-1 flex flex-col items-center justify-center text-center gap-3">
              <div class="text-14-medium text-text-strong">No campaign ledger yet</div>
              <div class="text-12-regular text-text-weak max-w-64">
                Start a research loop — ask Amico to run a campaign. Ledgers land in your personal vault's
                sessions/ directory and appear here: the objective, the verdict table, what's blocked, and the
                loop log.
              </div>
            </div>
          }
        >
          <div class="flex items-center gap-2 min-w-0">
            <div class="text-12-medium text-text-base truncate">{model().label}</div>
            <Show when={model().status}>
              <StatusChip status={model().status!} />
            </Show>
            <Show when={model().date}>
              <div class="text-11-regular text-text-faint shrink-0">{model().date}</div>
            </Show>
            <button
              class="ml-auto shrink-0 text-11-regular text-text-weak hover:text-text-base transition-colors"
              onClick={() => void refetch()}
            >
              Refresh
            </button>
          </div>

          <Show
            when={!detail.error}
            fallback={
              <div class="text-12-regular text-text-weak">
                The ledger for {picked()?.slug ?? "this campaign"} couldn't load.
              </div>
            }
          >
            <Show
              when={model().hasLedger}
              fallback={
                <div class="flex-1 flex items-center justify-center text-center">
                  <div class="text-12-regular text-text-weak max-w-56">
                    This campaign's ledger has no sections yet — they fill in as the loop runs.
                  </div>
                </div>
              }
            >
              <div class="flex-1 min-h-0 overflow-y-auto flex flex-col gap-4 pr-1">
                <Show when={model().objectiveLines.length > 0}>
                  <div class="flex flex-col gap-1">
                    <SectionLabel text="Objective" />
                    <For each={model().objectiveLines}>
                      {(line) => <div class="text-12-regular text-text-base">{line}</div>}
                    </For>
                  </div>
                </Show>

                <Show when={model().verdicts.length > 0}>
                  <div class="flex flex-col gap-1.5">
                    <SectionLabel text="Verdicts" note={model().verdictColumns.join(" · ") || undefined} />
                    <div class="rounded-md border border-border-weak-base overflow-hidden">
                      <For each={model().verdicts}>
                        {(verdict, index) => (
                          <div
                            class="flex items-start gap-3 px-2.5 py-1.5"
                            classList={{
                              "border-t border-border-weak-base": index() > 0,
                            }}
                          >
                            <div class="text-11-medium text-text-base w-28 shrink-0 truncate">{verdict.unit}</div>
                            <div class="w-20 shrink-0">
                              <StatusChip status={verdict.status} />
                            </div>
                            <div class="text-11-regular text-text-weak min-w-0 break-words">{verdict.evidence}</div>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>

                <div class="flex flex-col gap-1.5">
                  <SectionLabel text="Blocked" />
                  <Show
                    when={model().blockedLines.length > 0}
                    fallback={<div class="text-11-regular text-text-faint">Nothing blocked</div>}
                  >
                    <For each={model().blockedLines}>
                      {(line) => (
                        <div class="text-11-regular text-v2-state-fg-warning flex gap-1.5">
                          <span class="shrink-0">⚠</span>
                          <span class="min-w-0 break-words">{line}</span>
                        </div>
                      )}
                    </For>
                  </Show>
                </div>

                <div class="flex flex-col gap-1.5">
                  <SectionLabel text="Loop log" />
                  <Show
                    when={loopTable()}
                    fallback={
                      <Show
                        when={loopText()}
                        fallback={<div class="text-11-regular text-text-faint">No loop entries yet</div>}
                      >
                        {(lines) => (
                          <div class="flex flex-col gap-0.5">
                            <For each={lines()}>
                              {(line) => <div class="text-11-regular text-text-weak font-mono">{line}</div>}
                            </For>
                          </div>
                        )}
                      </Show>
                    }
                  >
                    {(rows) => (
                      <div class="rounded-md border border-border-weak-base overflow-hidden">
                        <For each={rows()}>
                          {(row, index) => (
                            <div
                              class="flex gap-3 px-2.5 py-1 font-mono text-11-regular text-text-weak"
                              classList={{ "border-t border-border-weak-base": index() > 0 }}
                            >
                              <For each={row}>{(cell) => <div class="min-w-0 break-words">{cell}</div>}</For>
                            </div>
                          )}
                        </For>
                      </div>
                    )}
                  </Show>
                </div>
              </div>
            </Show>
          </Show>
        </Show>
      </Show>
    </div>
  )
}
