// AMICODE: Connections tab body for the status popover (amicode#166, Pasqal
// card #169). A thin projection of connections.ts — cardModel/stateCopy carry
// the behavioral contract (and its tests; the repo has no tsx component
// harness), the app layer owns fetching and the one-round-trip overlay, and
// this file only renders. SECURITY: secrets (token, Pasqal password) live in
// password-masked inputs and the submit payload; they are never rendered as
// text and the masked input clears when a submit lands connected.
import { createEffect, createSignal, For, Show } from "solid-js"
import { Button } from "../components/button"
import { Spinner } from "../components/spinner"
import {
  cardModel,
  catalogForPicker,
  chooseProjectPayload,
  connectionAuthMethods,
  connectionDisplayName,
  connectionTitle,
  driftCopy,
  fillLabelTemplate,
  isCustomConnectionId,
  methodEntryKind,
  offlineCopy,
  pasqalSubmitPayload,
  pasqalTokenSubmitPayload,
  startAuthPayload,
  stateCopy,
  statusTabConnections,
  submitPayload,
  tokenOnlySubmitPayload,
  type ConnectionActionView,
  type ConnectionAuthMethod,
  type ConnectionsView,
  type ConnectionStateLabels,
  type ConnectionView,
  type CredentialSubmitPayload,
  type ChooseProjectPayload,
  type StartAuthPayload,
} from "./connections"
import { ConnectionIcon } from "./connection-icon"
import { ConnectionPicker } from "./connection-picker"

export type ConnectionsTabLabels = {
  empty: string
  retry: string
  states: ConnectionStateLabels
  baseUrlPlaceholder: string
  tokenPlaceholder: string
  usernamePlaceholder: string
  passwordPlaceholder: string
  projectIdPlaceholder: string
  submit: string
  disconnect: string
  revalidate: string
  staleHint: string
  sessionOnlyHint: string
  /** {{at}}/{{identity}} template — the offline last-verified line (170 AC3) */
  offlineHint: string
  /** {{answered}}/{{stored}} template — the submitter-drift diff (170 AC4) */
  driftHint: string
  /** auth-path scaffold (#194) — chooser chips, starts, mid-flow copy */
  methods: Record<ConnectionAuthMethod, string>
  startBrowser: string
  startDeviceCode: string
  cancel: string
  /** {{url}} template — where the device code gets entered */
  userCodeHint: string
  /** {{at}} template — pending-code expiry */
  codeExpiresHint: string
  useProject: string
}

export function AmicodeConnectionsTab(props: {
  view: ConnectionsView | undefined
  labels: ConnectionsTabLabels
  actionError?: string
  onSubmit: (payload: CredentialSubmitPayload) => Promise<ConnectionActionView>
  onDisconnect: (id: string) => void
  onRevalidate: (id: string) => void
  onRetry: () => void
  onAddCustom?: (payload: { name: string; token: string; url?: string }) => Promise<ConnectionActionView>
  onRemove?: (id: string) => Promise<void>
  /** auth-path scaffold (#194) — optional until the server routes exist; the
   *  UI that needs them is only reachable when the wire advertises methods */
  onStartAuth?: (payload: StartAuthPayload) => void
  onChooseProject?: (payload: ChooseProjectPayload) => void
  onCancelAuth?: (id: string) => void
}) {
  const [showPicker, setShowPicker] = createSignal(false)
  return (
    <div class="flex flex-col" data-component="amicode-connections-tab">
      <Show
        when={props.view}
        fallback={<div class="h-8 mx-2 my-1 rounded-md bg-surface-raised-base animate-pulse" aria-hidden />}
      >
        {(view) => (
          <Show
            when={view().ok}
            fallback={
              <div class="flex items-center gap-2 w-full px-2 py-1">
                <div class="size-1.5 rounded-full shrink-0 bg-icon-critical-base" />
                <span class="text-14-regular text-text-weak flex-1 truncate">{view().error}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="small"
                  class="shrink-0"
                  data-slot="amicode-connections-retry"
                  onClick={props.onRetry}
                >
                  {props.labels.retry}
                </Button>
              </div>
            }
          >
            <Show
              when={statusTabConnections(view().connections).length > 0}
              fallback={
                <div class="flex flex-col items-center gap-2 py-3" data-slot="amicode-connections-empty">
                  <span class="text-14-regular text-text-base text-center">No connections yet</span>
                  <Button type="button" variant="secondary" size="small" onClick={() => setShowPicker(true)} data-slot="amicode-connections-add">
                    Add connection
                  </Button>
                  <Show when={showPicker()}>
                    <ConnectionPicker
                      catalog={catalogForPicker(view().connections)}
                      onAddCustom={async (p) => {
                        if (props.onAddCustom) await props.onAddCustom(p)
                        setShowPicker(false)
                      }}
                      onSubmitToken={async (id, token) => {
                        const payload = tokenOnlySubmitPayload(id, token)
                        if (payload) await props.onSubmit(payload as CredentialSubmitPayload)
                        setShowPicker(false)
                      }}
                      onStartBrowser={(id) => {
                        // Browser login for google/google-drive: start OAuth in browser
                        const fakeView = { id, state: "needs-key" as const, rawState: "needs-key", validatedAt: "—", stale: false, authMethods: ["browser" as const] }
                        const payload = startAuthPayload(fakeView as any, "browser")
                        if (payload) props.onStartAuth?.(payload)
                        setShowPicker(false)
                      }}
                      onClose={() => setShowPicker(false)}
                    />
                  </Show>
                </div>
              }
            >
              <For each={statusTabConnections(view().connections)}>
                {(conn) => (
                  <ConnectionCard
                    conn={conn}
                    labels={props.labels}
                    actionError={props.actionError}
                    onSubmit={props.onSubmit}
                    onDisconnect={props.onDisconnect}
                    onRevalidate={props.onRevalidate}
                    onRemove={props.onRemove}
                    onStartAuth={props.onStartAuth}
                    onChooseProject={props.onChooseProject}
                    onCancelAuth={props.onCancelAuth}
                  />
                )}
              </For>
              <Show when={!showPicker()}>
                <Button type="button" variant="ghost" size="small" class="self-start mx-2 mt-2" data-slot="amicode-connections-add" onClick={() => setShowPicker(true)}>
                  Add connection
                </Button>
              </Show>
              <Show when={showPicker()}>
                <div class="px-2 pb-2">
                  <ConnectionPicker
                    catalog={catalogForPicker(view().connections)}
                    onAddCustom={async (p) => {
                      if (props.onAddCustom) await props.onAddCustom(p)
                      setShowPicker(false)
                    }}
                    onSubmitToken={async (id, token) => {
                      const payload = tokenOnlySubmitPayload(id, token)
                      if (payload) await props.onSubmit(payload as CredentialSubmitPayload)
                      setShowPicker(false)
                    }}
                    onStartBrowser={(id) => {
                      const fakeView = { id, state: "needs-key" as const, rawState: "needs-key", validatedAt: "—", stale: false, authMethods: ["browser" as const] }
                      const payload = startAuthPayload(fakeView as any, "browser")
                      if (payload) props.onStartAuth?.(payload)
                      setShowPicker(false)
                    }}
                    onClose={() => setShowPicker(false)}
                  />
                </div>
              </Show>
            </Show>
          </Show>
        )}
      </Show>
    </div>
  )
}

const TONE_DOT: Record<ReturnType<typeof cardModel>["tone"], string> = {
  success: "bg-icon-success-base",
  critical: "bg-icon-critical-base",
  warning: "bg-icon-warning-base",
  pending: "bg-icon-warning-base animate-pulse",
  neutral: "bg-border-weak-base",
}

/** amicode#200: exported — the solver toggle's popover mounts the SAME card
 *  for Company Compute (connect / connected-manage / expired states). */
export function ConnectionCard(props: {
  conn: ConnectionView
  labels: ConnectionsTabLabels
  actionError?: string
  onSubmit: (payload: CredentialSubmitPayload) => Promise<ConnectionActionView>
  onDisconnect: (id: string) => void
  onRevalidate: (id: string) => void
  onRemove?: (id: string) => Promise<void>
  onStartAuth?: (payload: StartAuthPayload) => void
  onChooseProject?: (payload: ChooseProjectPayload) => void
  onCancelAuth?: (id: string) => void
  /** amicode#200 (capsule mount): the accordion header already names and
   *  dots the connection — hide the card's own title row so the connection
   *  STATUS is the first and only heading text. */
  hideHeader?: boolean
}) {
  const model = () => cardModel(props.conn)
  const methods = () => connectionAuthMethods(props.conn)
  // chooser selection (#194): defaults to the first advertised method and
  // snaps back if a re-fetch stops advertising the chosen one
  const [chosen, setChosen] = createSignal<ConnectionAuthMethod | undefined>(undefined)
  const method = () => {
    const current = chosen()
    return current && methods().includes(current) ? current : methods()[0]
  }
  const entryKind = () => methodEntryKind(props.conn.id, method())
  const [baseUrl, setBaseUrl] = createSignal("")
  const [token, setToken] = createSignal("")
  // pasqal credentials (#169): request-scope only — the password signal feeds
  // the payload and nothing else, and clears the moment a submit connects
  const [username, setUsername] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [projectId, setProjectId] = createSignal("")
  const [pickedProject, setPickedProject] = createSignal("")

  // wire-offered prefill fills an untouched field only, never overwrites input
  createEffect(() => {
    const wire = props.conn.baseUrl
    if (wire && baseUrl() === "") setBaseUrl(wire)
  })

  const submit = async (event: Event) => {
    event.preventDefault()
    const kind = entryKind()
    const payload =
      kind === "pasqal-credentials"
        ? pasqalSubmitPayload(props.conn.id, username(), password()) // #194: no project_id → server lists projects
        : kind === "pasqal-token"
          ? pasqalTokenSubmitPayload(props.conn.id, token(), projectId())
          : kind === "token-only"
            ? tokenOnlySubmitPayload(props.conn.id, token())
            : submitPayload(props.conn.id, baseUrl(), token())
    if (!payload) return // AC3: empty submission — no request, no state change
    const result = await props.onSubmit(payload as CredentialSubmitPayload)
    // clear the masked inputs once accepted; secrets are never echoed back
    if (result.ok && result.connection?.state === "connected") {
      setToken("")
      setPassword("")
    }
  }

  const startAuth = () => {
    const payload = startAuthPayload(props.conn, method())
    if (payload) props.onStartAuth?.(payload)
  }

  const chooseProject = () => {
    const payload = chooseProjectPayload(props.conn, pickedProject() || (props.conn.projects?.[0]?.id ?? ""))
    if (payload) props.onChooseProject?.(payload)
  }

  return (
    <div class="flex flex-col w-full px-2 py-1" data-slot="amicode-connection-card" data-state={props.conn.state}>
      <Show when={!props.hideHeader}>
        <div class="flex items-center gap-2 w-full min-w-0">
          <ConnectionIcon conn={props.conn} />
          <span class="text-14-regular text-text-base truncate">{connectionDisplayName(props.conn)}</span>
          <Show when={model().showRawState}>
            <span class="text-11-regular text-text-base bg-surface-base px-1.5 py-0.5 rounded-md shrink-0">
              {props.conn.rawState}
            </span>
          </Show>
          <div class="flex-1" />
          <Show when={model().showValidatedAt}>
            <span class="text-12-regular text-text-weak shrink-0" data-slot="amicode-connection-validated-at">
              {props.conn.validatedAt}
            </span>
          </Show>
        </div>
      </Show>

      <div
        class={`${props.hideHeader ? "flex items-center gap-2 " : ""}text-12-regular text-text-weak`}
        data-slot="amicode-connection-state-copy"
      >
        <Show when={props.hideHeader}>
          <ConnectionIcon conn={props.conn} />
        </Show>
        {stateCopy(props.conn, props.labels.states)}
        <Show when={model().showIdentity}>
          <span class="text-text-base"> · {props.conn.identity}</span>
        </Show>
      </div>

      <Show when={model().showDrift}>
        <div class="flex items-center gap-2" data-slot="amicode-connection-drift">
          <div class="size-1 rounded-full shrink-0 bg-icon-warning-base" />
          <span class="text-11-regular text-text-weak">{driftCopy(props.conn, props.labels.driftHint)}</span>
        </div>
      </Show>

      <Show when={model().showSessionOnly}>
        <div class="text-11-regular text-text-weaker truncate" data-slot="amicode-connection-session-only">
          {props.labels.sessionOnlyHint}
        </div>
      </Show>

      <Show when={model().showOffline}>
        <div class="text-11-regular text-text-weak truncate" data-slot="amicode-connection-offline">
          {offlineCopy(props.conn, props.labels.offlineHint)}
        </div>
      </Show>

      <Show when={model().showStale}>
        <div class="text-11-regular text-text-weaker truncate">{props.labels.staleHint}</div>
      </Show>

      <Show when={props.actionError}>
        <div class="flex items-center gap-2" data-slot="amicode-connection-action-error">
          <div class="size-1 rounded-full shrink-0 bg-icon-critical-base" />
          <span class="text-11-regular text-text-weak truncate">{props.actionError}</span>
        </div>
      </Show>

      <Show when={model().showUserCode}>
        <div class="flex flex-col gap-1 pt-1.5" data-slot="amicode-connection-user-code">
          <div
            class="text-14-regular text-text-base bg-surface-base rounded-md px-2 py-1.5 border border-border-weak-base text-center"
            style={{ "font-family": "ui-monospace, monospace", "letter-spacing": "0.14em", "user-select": "all" }}
          >
            {props.conn.userCode}
          </div>
          <Show when={props.conn.verificationUrl}>
            <span class="text-11-regular text-text-weak truncate">
              {fillLabelTemplate(props.labels.userCodeHint, { url: props.conn.verificationUrl ?? "—" })}
            </span>
          </Show>
          <Show when={props.conn.codeExpiresAt}>
            <span class="text-11-regular text-text-weaker truncate">
              {fillLabelTemplate(props.labels.codeExpiresHint, { at: props.conn.codeExpiresAt ?? "—" })}
            </span>
          </Show>
        </div>
      </Show>

      <Show when={model().showProjectPicker}>
        <div
          class="flex flex-col gap-1.5 pt-1.5"
          data-slot="amicode-connection-projects"
          role="radiogroup"
          aria-label={connectionTitle(props.conn.id)}
        >
          <For each={props.conn.projects}>
            {(project) => {
              const selected = () => (pickedProject() || props.conn.projects?.[0]?.id) === project.id
              return (
                <label
                  class="flex items-baseline gap-2.5 rounded-md px-2.5 py-2 border cursor-pointer min-w-0"
                  data-slot="amicode-connection-project"
                  data-selected={selected()}
                  style={{
                    "border-color": selected() ? "var(--accent-edge)" : "var(--v2-border-border-base)",
                    "background-color": selected() ? "var(--accent-fill-soft)" : "var(--v2-background-bg-layer-01)",
                  }}
                >
                  <input
                    type="radio"
                    name={`amicode-project-${props.conn.id}`}
                    value={project.id}
                    checked={selected()}
                    onInput={() => setPickedProject(project.id)}
                    style={{ "accent-color": "var(--v2-border-border-focus)", "flex-shrink": "0" }}
                  />
                  <span class="flex flex-col min-w-0 gap-0.5">
                    <span class="text-12-regular text-text-base truncate">{project.name}</span>
                    <span class="text-11-regular text-text-weaker truncate">{project.id}</span>
                  </span>
                </label>
              )
            }}
          </For>
          <Button
            type="button"
            variant="primary"
            size="small"
            class="self-start mt-0.5"
            data-slot="amicode-connection-use-project"
            onClick={chooseProject}
          >
            {props.labels.useProject}
          </Button>
        </div>
      </Show>

      <Show when={model().showWaiting}>
        <div class="flex items-center gap-2 pt-1" data-slot="amicode-connection-waiting">
          <div class="size-1.5 rounded-full shrink-0 bg-icon-warning-base animate-pulse" />
          <div class="flex-1" />
          <Button
            type="button"
            variant="ghost"
            size="small"
            data-slot="amicode-connection-cancel"
            onClick={() => props.onCancelAuth?.(props.conn.id)}
          >
            {props.labels.cancel}
          </Button>
        </div>
      </Show>

      <Show when={model().showForm}>
        <div class="flex flex-col gap-1.5 pt-1.5">
          <Show when={methods().length > 1}>
            <div class="flex gap-1 flex-wrap" data-slot="amicode-connection-methods" role="group">
              <For each={methods()}>
                {(entry) => (
                  <Button
                    type="button"
                    variant={method() === entry ? "secondary" : "ghost"}
                    size="small"
                    aria-pressed={method() === entry}
                    data-method={entry}
                    onClick={() => setChosen(entry)}
                  >
                    {props.labels.methods[entry]}
                  </Button>
                )}
              </For>
            </div>
          </Show>
          <Show
            when={entryKind() !== "none"}
            fallback={
              <Button
                type="button"
                variant="primary"
                size="small"
                class="self-start"
                disabled={model().formDisabled}
                data-slot="amicode-connection-start"
                onClick={startAuth}
              >
                {method() === "browser" ? props.labels.startBrowser : props.labels.startDeviceCode}
              </Button>
            }
          >
            <form class="flex flex-col gap-1.5" data-slot="amicode-connection-form" onSubmit={submit}>
              <Show when={entryKind() === "pasqal-credentials"}>
                <input
                  type="text"
                  name="username"
                  autocomplete="off"
                  spellcheck={false}
                  placeholder={props.labels.usernamePlaceholder}
                  aria-label={props.labels.usernamePlaceholder}
                  value={username()}
                  disabled={model().formDisabled}
                  onInput={(event) => setUsername(event.currentTarget.value)}
                  class="amc-input amc-input--compact"
                />
                <input
                  type="password"
                  name="password"
                  autocomplete="off"
                  placeholder={props.labels.passwordPlaceholder}
                  aria-label={props.labels.passwordPlaceholder}
                  value={password()}
                  disabled={model().formDisabled}
                  onInput={(event) => setPassword(event.currentTarget.value)}
                  class="amc-input amc-input--compact"
                />
              </Show>
              <Show when={entryKind() === "base-url-token"}>
                <input
                  type="text"
                  name="base_url"
                  autocomplete="off"
                  spellcheck={false}
                  placeholder={props.labels.baseUrlPlaceholder}
                  aria-label={props.labels.baseUrlPlaceholder}
                  value={baseUrl()}
                  disabled={model().formDisabled}
                  onInput={(event) => setBaseUrl(event.currentTarget.value)}
                  class="amc-input amc-input--compact"
                />
              </Show>
              <Show when={entryKind() === "token-only"}>
                <input
                  type="password"
                  name="token"
                  autocomplete="off"
                  placeholder={props.labels.tokenPlaceholder}
                  aria-label={props.labels.tokenPlaceholder}
                  value={token()}
                  disabled={model().formDisabled}
                  onInput={(event) => setToken(event.currentTarget.value)}
                  class="amc-input amc-input--compact"
                />
              </Show>
              <Show when={entryKind() === "base-url-token" || entryKind() === "pasqal-token"}>
                <input
                  type="password"
                  name="token"
                  autocomplete="off"
                  placeholder={props.labels.tokenPlaceholder}
                  aria-label={props.labels.tokenPlaceholder}
                  value={token()}
                  disabled={model().formDisabled}
                  onInput={(event) => setToken(event.currentTarget.value)}
                  class="amc-input amc-input--compact"
                />
              </Show>
              <Show when={entryKind() === "pasqal-token"}>
                <input
                  type="text"
                  name="project_id"
                  autocomplete="off"
                  spellcheck={false}
                  placeholder={props.labels.projectIdPlaceholder}
                  aria-label={props.labels.projectIdPlaceholder}
                  value={projectId()}
                  disabled={model().formDisabled}
                  onInput={(event) => setProjectId(event.currentTarget.value)}
                  class="amc-input amc-input--compact"
                />
              </Show>
              <Button
                type="submit"
                variant="primary"
                size="small"
                disabled={model().formDisabled}
                data-slot="amicode-connection-submit"
                class="self-start"
              >
                {props.labels.submit}
              </Button>
            </form>
          </Show>
        </div>
      </Show>

      <Show when={model().showActions}>
        <div class="flex gap-3 pt-1">
          <Button
            type="button"
            variant="secondary"
            size="small"
            data-slot="amicode-connection-revalidate"
            onClick={() => props.onRevalidate(props.conn.id)}
          >
            {props.labels.revalidate}
          </Button>
          <Show when={isCustomConnectionId(props.conn.id)} fallback={
            <Button
              type="button"
              variant="ghost"
              size="small"
              data-slot="amicode-connection-disconnect"
              onClick={() => props.onDisconnect(props.conn.id)}
            >
              {props.labels.disconnect}
            </Button>
          }>
            <Button
              type="button"
              variant="ghost"
              size="small"
              data-slot="amicode-connection-remove"
              onClick={async () => {
                if (props.onRemove) await props.onRemove(props.conn.id)
                else props.onDisconnect(props.conn.id)
              }}
            >
              Remove
            </Button>
          </Show>
        </div>
      </Show>
    </div>
  )
}
