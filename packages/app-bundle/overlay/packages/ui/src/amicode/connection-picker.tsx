// AMICODE: ConnectionPicker — Add-flow picker list + inline forms (issue #327)
import { createSignal, For, Show } from "solid-js"
import { Button } from "../components/button"
import { CONNECTION_ICONS, customConnectionPayload, tokenOnlySubmitPayload } from "./connections"

/** Open a URL via the extension bridge (window.open is dead in the webview
 *  iframe); plain-browser contexts fall back to window.open. */
function openExternal(url: string) {
  if (window.parent !== window) window.parent.postMessage({ source: "amicode", kind: "open-external", url }, "*")
  else window.open(url, "_blank", "noreferrer")
}

export type CatalogEntry = { id: string; name: string; icon: string; authShape: string }

export function ConnectionPicker(props: {
  catalog: CatalogEntry[]
  onAddCustom: (payload: { name: string; token: string; url?: string }) => Promise<void>
  onSubmitToken: (id: string, token: string) => Promise<void>
  onStartBrowser?: (id: string) => void
  onClose: () => void
}) {
  const [picked, setPicked] = createSignal<string | undefined>(undefined)
  const [customName, setCustomName] = createSignal("")
  const [customToken, setCustomToken] = createSignal("")
  const [customUrl, setCustomUrl] = createSignal("")
  const [token, setToken] = createSignal("")

  const pickedEntry = () => props.catalog.find((e) => e.id === picked())
  // Google now supports both token and browser — treat it as token in the picker
  // so users can paste a token like Claude/Slack/GitHub, with browser as alternative
  const isBrowserEntry = () => {
    const entry = pickedEntry()
    if (!entry) return false
    if (entry.id === "google" || entry.id === "google-drive") return false
    return entry.authShape === "browser"
  }
  const isGoogleEntry = () => {
    const entry = pickedEntry()
    return entry?.id === "google" || entry?.id === "google-drive"
  }
  const isSlackEntry = () => pickedEntry()?.id === "slack"
  const [slackClientId, setSlackClientId] = createSignal("")
  const [slackClientSecret, setSlackClientSecret] = createSignal("")

  const submitCustom = async (e: Event) => {
    e.preventDefault()
    const payload = customConnectionPayload(customName(), customToken(), customUrl())
    if (!payload) return
    await props.onAddCustom(payload)
    setCustomName("")
    setCustomToken("")
    setCustomUrl("")
    setPicked(undefined)
  }

  const submitToken = async (e: Event) => {
    e.preventDefault()
    const id = picked()
    if (!id || id === "custom") return
    const payload = tokenOnlySubmitPayload(id, token())
    if (!payload) return
    await props.onSubmitToken(id, token())
    setToken("")
    setPicked(undefined)
  }

  const startBrowser = (e: Event) => {
    e.preventDefault()
    const id = picked()
    if (!id) return
    if (props.onStartBrowser) props.onStartBrowser(id)
    else {
      // Fallback: if no browser handler, treat as token flow for backwards compat
    }
    setPicked(undefined)
  }

  const isCustom = () => picked() === "custom"
  const isBuiltIn = () => picked() !== undefined && picked() !== "custom"

  return (
    <div class="flex flex-col gap-2 p-2 border border-border-weak-base rounded-md bg-surface-raised-base" data-slot="amicode-connection-picker">
      <div class="flex items-center justify-between">
        <span class="text-12-regular text-text-base font-medium">Add connection</span>
        <Button type="button" variant="ghost" size="small" onClick={props.onClose}>
          Close
        </Button>
      </div>

      <Show when={!picked()}>
        <div class="flex flex-col gap-1">
          <button
            type="button"
            class="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-base border border-dashed border-border-weak-base text-left"
            data-slot="amicode-picker-custom"
            onClick={() => setPicked("custom")}
          >
            <div class="w-[18px] h-[18px] rounded-sm bg-accent-fill-soft flex items-center justify-center text-10-regular">+</div>
            <span class="text-12-regular text-text-base">Custom connection</span>
          </button>
          <For each={props.catalog}>
            {(entry) => (
              <button
                type="button"
                class="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-base border border-border-weak-base text-left"
                data-slot="amicode-picker-builtin"
                data-id={entry.id}
                onClick={() => setPicked(entry.id)}
              >
                <span class="w-[18px] h-[18px] flex items-center justify-center text-text-base" innerHTML={entry.icon} />
                <span class="text-12-regular text-text-base">{entry.name}</span>
                <Show when={entry.authShape === "browser"}>
                  <span class="ml-auto text-10-regular text-text-weaker border border-border-weak-base rounded px-1 py-0">Browser</span>
                </Show>
              </button>
            )}
          </For>
          <Show when={props.catalog.length === 0}>
            <span class="text-11-regular text-text-weaker px-2">All built-ins already added</span>
          </Show>
        </div>
      </Show>

      <Show when={isCustom()}>
        <form class="flex flex-col gap-1.5" onSubmit={submitCustom} data-slot="amicode-picker-custom-form">
          <input
            type="text"
            placeholder="Name"
            aria-label="Name"
            value={customName()}
            onInput={(e) => setCustomName(e.currentTarget.value)}
            class="amc-input amc-input--compact"
          />
          <input
            type="password"
            placeholder="Token"
            aria-label="Token"
            value={customToken()}
            onInput={(e) => setCustomToken(e.currentTarget.value)}
            class="amc-input amc-input--compact"
          />
          <input
            type="text"
            placeholder="URL (optional)"
            aria-label="URL"
            value={customUrl()}
            onInput={(e) => setCustomUrl(e.currentTarget.value)}
            class="amc-input amc-input--compact"
          />
          <div class="flex gap-2">
            <Button type="submit" variant="primary" size="small">
              Add
            </Button>
            <Button type="button" variant="ghost" size="small" onClick={() => setPicked(undefined)}>
              Back
            </Button>
          </div>
        </form>
      </Show>

      <Show when={isBuiltIn()}>
        <Show when={isBrowserEntry()} fallback={
          <Show when={isSlackEntry()} fallback={
            <Show when={isGoogleEntry()} fallback={
              <form class="flex flex-col gap-1.5" onSubmit={submitToken} data-slot="amicode-picker-token-form">
                <span class="text-12-regular text-text-base">{picked()}</span>
                <input
                  type="password"
                  placeholder="Token"
                  aria-label="Token"
                  value={token()}
                  onInput={(e) => setToken(e.currentTarget.value)}
                  class="amc-input amc-input--compact"
                />
                <div class="flex gap-2">
                  <Button type="submit" variant="primary" size="small">
                    Connect
                  </Button>
                  <Button type="button" variant="ghost" size="small" onClick={() => setPicked(undefined)}>
                    Back
                  </Button>
                </div>
              </form>
            }>
              {/* Google: token (paste like Claude) + browser alternative */}
              <form class="flex flex-col gap-1.5" onSubmit={submitToken} data-slot="amicode-picker-token-form">
                <span class="text-12-regular text-text-base">{picked()}</span>
                <input
                  type="password"
                  placeholder="Paste Google token (or use browser below)"
                  aria-label="Token"
                  value={token()}
                  onInput={(e) => setToken(e.currentTarget.value)}
                  class="amc-input amc-input--compact"
                />
                <div class="flex gap-2">
                  <Button type="submit" variant="primary" size="small">
                    Connect with token
                  </Button>
                  <Button type="button" variant="ghost" size="small" onClick={() => setPicked(undefined)}>
                    Back
                  </Button>
                </div>
                <div class="text-11-regular text-text-weaker text-center">— or —</div>
                <Button type="button" variant="secondary" size="small" onClick={startBrowser} data-slot="amicode-picker-browser-start">
                  Sign in with browser
                </Button>
              </form>
            </Show>
          }>
             {/* Slack: Client ID + Client Secret + OAuth flow */}
            <div class="flex flex-col gap-1.5" data-slot="amicode-picker-slack-form">
              <div class="flex items-center gap-2">
                <span class="w-[18px] h-[18px] flex items-center justify-center" innerHTML={CONNECTION_ICONS.slack ?? ""} />
                <span class="text-12-regular text-text-base font-medium">Slack</span>
              </div>
              <details class="text-11-regular text-text-weaker">
                <summary class="cursor-pointer hover:text-text-base">Where do I find these?</summary>
                <div class="flex flex-col gap-1.5 mt-1.5 pl-1">
                  <span>Go to <span class="underline text-text-base cursor-pointer" onClick={() => openExternal("https://api.slack.com/apps")}>api.slack.com/apps</span> → your app → Basic Information → App Credentials. Or ask your Slack workspace admin.</span>
                </div>
              </details>
              <input
                type="text"
                placeholder="Client ID"
                aria-label="Slack App Client ID"
                value={slackClientId()}
                onInput={(e) => setSlackClientId(e.currentTarget.value)}
                class="amc-input amc-input--compact"
              />
              <input
                type="password"
                placeholder="Client Secret"
                aria-label="Slack App Client Secret"
                value={slackClientSecret()}
                onInput={(e) => setSlackClientSecret(e.currentTarget.value)}
                class="amc-input amc-input--compact"
              />
              <div class="flex gap-2">
                <Button type="button" variant="primary" size="small" onClick={async (e) => {
                  e.preventDefault()
                  const cid = slackClientId().trim()
                  const csecret = slackClientSecret().trim()
                  if (!cid || !csecret) return
                  await props.onSubmitToken("slack-app-credentials", JSON.stringify({ client_id: cid, client_secret: csecret }))
                  setSlackClientId("")
                  setSlackClientSecret("")
                  if (props.onStartBrowser) props.onStartBrowser("slack")
                  setPicked(undefined)
                }}>
                  Save &amp; Connect
                </Button>
                <Button type="button" variant="ghost" size="small" onClick={() => setPicked(undefined)}>
                  Back
                </Button>
              </div>
              <div class="text-11-regular text-text-weaker text-center">— or —</div>
              <form class="flex flex-col gap-1.5" onSubmit={submitToken}>
                <input
                  type="password"
                  placeholder="Paste user token (advanced)"
                  aria-label="Token"
                  value={token()}
                  onInput={(e) => setToken(e.currentTarget.value)}
                  class="amc-input amc-input--compact"
                />
                <Button type="submit" variant="ghost" size="small">
                  Connect with token
                </Button>
              </form>
            </div>
          </Show>
        }>
          <div class="flex flex-col gap-1.5" data-slot="amicode-picker-browser-form">
            <span class="text-12-regular text-text-base">{picked()}</span>
            <span class="text-11-regular text-text-weaker">Sign in with your browser to connect {pickedEntry()?.name ?? picked()}.</span>
            <div class="flex gap-2">
              <Button type="button" variant="primary" size="small" onClick={startBrowser} data-slot="amicode-picker-browser-start">
                Sign in with browser
              </Button>
              <Button type="button" variant="ghost" size="small" onClick={() => setPicked(undefined)}>
                Back
              </Button>
            </div>
          </div>
        </Show>
      </Show>
    </div>
  )
}
