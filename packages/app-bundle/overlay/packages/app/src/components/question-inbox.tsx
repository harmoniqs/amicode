// amicode#1786 (S2) — the question inbox surface: a titlebar badge (the count
// of every pending question reachable from this client's shared store) plus
// the panel drawer listing each with its session identity and a staleness
// read, answerable in place — no session view required. The state lives in
// the per-window controller (context/question-inbox, the vault-panel
// singleton pattern); this file is render composition over it, exactly like
// the in-session dock renders the same shared store.
import { createMemo, For, Show, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import type { QuestionRequest } from "@opencode-ai/sdk/v2/client"
import { questionInbox, type InboxEntry } from "@/context/question-inbox"

/** #1786: does every question of the request have at least one answer? */
function answerableQuestions(request: QuestionRequest, answers: (string[] | undefined)[]) {
  return request.questions.every((question, index) => (answers[index]?.length ?? 0) > 0)
}

function answersFor(request: QuestionRequest, answers: (string[] | undefined)[]) {
  // Order matches the request's questions; text-kind questions fall back to
  // their pre-filled default (the dock's submit gate treats empty text as
  // unanswered — the submit button reflects the same rule).
  return request.questions.map((_, index) => answers[index] ?? [])
}

function ageText(ageMs: number) {
  if (ageMs < 60_000) return `${Math.max(1, Math.round(ageMs / 1000))}s`
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m`
  return `${Math.round(ageMs / 3_600_000)}h`
}

/** The titlebar control: the inbox bell + pending count. Always rendered —
 *  the sortable layout needs the control present — with the count chip and
 *  an attention tint only while questions wait. */
export const QuestionInboxBadge: Component = () => {
  const inbox = questionInbox()
  const count = createMemo(() => inbox.entries().length)
  return (
    <span class="flex shrink-0" data-tour-target="inbox">
      <TooltipV2 placement="bottom" value={count() > 0 ? `Question inbox — ${count()} pending` : "Question inbox"} class="shrink-0">
        <span class="relative flex shrink-0">
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="large"
            class="!w-9 shrink-0"
            icon={<IconV2 name="help" />}
            state={inbox.opened() ? "pressed" : undefined}
            onClick={inbox.toggle}
            aria-label="Question inbox"
          />
          <Show when={count() > 0}>
            {/* the count chip is black-on-yellow (the accent's only light-mode legibility) */}
            <span class="pointer-events-none absolute right-0 top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--accent)] px-1 text-10-regular font-[600] text-[var(--accent-ink)] tabular-nums">
              {count() > 99 ? "99+" : count()}
            </span>
          </Show>
        </span>
      </TooltipV2>
    </span>
  )
}

function InboxEntryCard(props: { entry: InboxEntry; disabled: boolean }) {
  const inbox = questionInbox()
  // Draft answers per question index for this entry; cleared with the entry.
  const [draft, setDraft] = createStore<{ answers: (string[] | undefined)[] }>({
    answers: props.entry.request.questions.map((question) =>
      question.options.length === 0 && question.default ? [question.default] : undefined,
    ),
  })
  const ready = createMemo(() => answerableQuestions(props.entry.request, draft.answers))
  const sessionLabel = () => props.entry.title ?? props.entry.sessionID

  const pick = (index: number, label: string, multiple: boolean) => {
    setDraft(
      "answers",
      index,
      multiple ? (current) => (current?.includes(label) ? current.filter((item) => item !== label) : [...(current ?? []), label]) : [label],
    )
  }

  const submit = () => {
    if (props.disabled || !ready() || inbox.pending(props.entry.id)) return
    void inbox
      .submit({
        sessionID: props.entry.sessionID,
        requestID: props.entry.id,
        directory: props.entry.directory,
        answers: answersFor(props.entry.request, draft.answers),
      })
      .catch(() => {})
  }

  return (
    <div
      data-component="question-inbox-entry"
      data-entry-id={props.entry.id}
      data-stale={props.entry.stale ? "true" : undefined}
      class="flex flex-col gap-2 rounded-[var(--radius-lg)] border border-border-weak-base bg-[var(--v2-background-bg-layer-01)] p-3"
    >
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0 text-12-medium text-text-base truncate">{sessionLabel()}</div>
        <div class="flex shrink-0 items-center gap-1.5">
          <Show when={props.entry.stale}>
            <span class="text-10-regular text-text-faint">stale · {ageText(props.entry.ageMs)}</span>
          </Show>
          <span class="text-10-regular text-text-faint tabular-nums">waiting {ageText(Date.now() - props.entry.askedAt)}</span>
        </div>
      </div>
      <For each={props.entry.request.questions}>
        {(question, index) => (
          <div class="flex flex-col gap-1.5">
            <div class="text-12-regular text-text-base">{question.question}</div>
            <div class="flex flex-wrap gap-1.5">
              <For each={question.options}>
                {(option) => (
                  <button
                    type="button"
                    data-slot="question-inbox-option"
                    data-picked={draft.answers[index()]?.includes(option.label) ? "true" : undefined}
                    class="cursor-pointer rounded-[var(--radius-md)] border border-border-weak-base px-2 py-1 text-left text-12-regular text-text-base transition-colors hover:border-border-strong-base focus-visible:border-border-focus-base focus-visible:outline-none"
                    classList={{
                      "border-border-strong-base bg-[var(--accent-fill-soft)]":
                        draft.answers[index()]?.includes(option.label) === true,
                    }}
                    disabled={props.disabled}
                    onClick={() => pick(index(), option.label, question.multiple === true)}
                  >
                    {option.label}
                  </button>
                )}
              </For>
              <Show when={question.options.length === 0 || question.custom !== false}>
                <input
                  data-slot="question-inbox-custom"
                  class="min-w-0 flex-1 rounded-[var(--radius-md)] border border-border-weak-base bg-[var(--v2-background-bg-layer-02)] px-2 py-1 text-12-regular text-text-base outline-none focus-visible:border-border-focus-base"
                  placeholder={question.default || "Type your answer"}
                  value={draft.answers[index()]?.[0] ?? ""}
                  disabled={props.disabled}
                  onInput={(event) => {
                    const text = event.currentTarget.value.trim()
                    setDraft("answers", index(), text ? [text] : undefined)
                  }}
                />
              </Show>
            </div>
          </div>
        )}
      </For>
      <div class="flex justify-end">
        <button
          type="button"
          data-slot="question-inbox-submit"
          class="cursor-pointer rounded-[var(--radius-md)] bg-[var(--accent)] px-3 py-1 text-12-medium text-[var(--accent-ink)] transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-focus-base disabled:cursor-default disabled:opacity-60"
          disabled={props.disabled || !ready()}
          onClick={submit}
        >
          Answer
        </button>
      </div>
    </div>
  )
}

/** The panel drawer — the VaultPanel's host shape: one global host on every
 *  route (mounted by the layout that owns the server provider scope). */
export function QuestionInboxPanel() {
  const inbox = questionInbox()
  return (
    <Show when={inbox.opened()}>
      <aside
        data-component="amico-question-inbox-panel"
        aria-label="Question inbox"
        class="fixed bottom-2 left-18 top-12 z-40 flex w-[360px] max-w-[85vw] flex-col overflow-hidden rounded-xl border border-border-weaker-base bg-background-base shadow-[var(--v2-elevation-raised)]"
      >
        <div class="flex items-center justify-between gap-2 border-b border-border-weaker-base px-3 py-2">
          <div class="flex items-center gap-1.5 text-12-medium text-text-base">
            {/* the rail's one accent rule: solid yellow chips carry near-black ink */}
            <span class="text-11-regular text-text-faint">AMICO</span>
            <span>·</span>
            <span>Question inbox</span>
          </div>
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="normal"
            icon={<IconV2 name="close" />}
            onClick={inbox.close}
            aria-label="Close question inbox"
          />
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto p-2">
          <Show
            when={inbox.entries().length > 0}
            fallback={<div class="px-2 py-8 text-center text-12-regular text-text-weak">No pending questions.</div>}
          >
            <div class="flex flex-col gap-2">
              <For each={inbox.entries()}>
                {(entry) => <InboxEntryCard entry={entry} disabled={inbox.pending(entry.id)} />}
              </For>
            </div>
          </Show>
        </div>
      </aside>
    </Show>
  )
}
