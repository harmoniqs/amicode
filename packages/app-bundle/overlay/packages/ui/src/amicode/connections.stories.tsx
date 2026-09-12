// @ts-nocheck
// Self-contained preview of the Connections tab auth-path scaffold
// (amicode#194 state atlas). Mock wire data only — NOT wired to the server;
// every state and every entry path is reviewable here without any Pasqal
// client config existing yet. The matrix is the design deliverable: four ways
// in (browser / password / device code / token), one shared lifecycle.
import { createSignal, For } from "solid-js"
import { AmicodeConnectionsTab } from "./connections-tab"
import { parseConnectionsResponse } from "./connections"

export default {
  title: "Amicode/ConnectionsAuthPaths",
  id: "amicode-connections-auth-paths",
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: `### Connections tab — auth-path state atlas (#194)

Every candidate auth mechanism scaffolded behind the wire contract: cards render
exactly as today until the server advertises \`auth_methods\` or emits a mid-flow
state (\`waiting-browser\` / \`waiting-code\` / \`choose-project\`). Mock data; the
server routes are a separate slice, pending the mechanism decision.`,
      },
    },
  },
}

const LABELS = {
  empty: "No connections available",
  retry: "Retry",
  states: {
    connected: "Connected",
    "needs-key": "Not connected — enter a key to connect",
    invalid: "Key rejected — check it and try again",
    expired: "Token expired — reconnect to mint a fresh one",
    unreachable: "Service unreachable — check the URL or try again",
    unentitled: "Project not authorized — check the project ID",
    validating: "Validating key…",
    "waiting-browser": "Waiting for your browser — finish signing in there",
    "waiting-code": "Waiting for the code — enter it on any device",
    "choose-project": "Signed in — pick the project runs should bill to",
    unknown: "Status needs attention",
  },
  baseUrlPlaceholder: "Service URL",
  tokenPlaceholder: "API key",
  usernamePlaceholder: "Username",
  passwordPlaceholder: "Password",
  projectIdPlaceholder: "Project ID",
  submit: "Connect",
  disconnect: "Disconnect",
  revalidate: "Revalidate",
  staleHint: "Last check is stale — revalidate to refresh",
  sessionOnlyHint: "Session-only — you'll be asked to reconnect after a restart",
  offlineHint: "Offline — last verified {{at}} as {{identity}}",
  driftHint: "This key answered as {{answered}}, was {{stored}} — historical runs may stop authorizing",
  methods: { credentials: "Password", browser: "Browser", "device-code": "Device code", token: "Token" },
  startBrowser: "Connect with browser",
  startDeviceCode: "Connect with a code",
  cancel: "Cancel",
  userCodeHint: "Enter this code at {{url}}",
  codeExpiresHint: "Code expires {{at}}",
  useProject: "Use this project",
}

const ALL_METHODS = ["browser", "credentials", "device-code", "token"]
const PROJECTS = [
  { id: "7d21ce09-88a3-4f2e-9c41-3f0b7e5a12aa", name: "MIS ladder" },
  { id: "c4a91b77-2e05-40d1-8f6a-90cf51d2ab10", name: "Hackathon sandbox" },
  { id: "f19e2d40-6b3c-47a8-b5d2-1c8ea0774e55", name: "Calibration scratch" },
]

const noop = { onSubmit: async () => ({ ok: true }), onDisconnect: () => {}, onRevalidate: () => {}, onRetry: () => {} }

function fixture(title, entry) {
  return { title, view: parseConnectionsResponse({ ok: true, connections: [entry] }) }
}

const MATRIX = [
  fixture("legacy today — no methods advertised (unchanged #169 card)", {
    id: "pasqal-cloud",
    state: "needs-key",
  }),
  fixture("entry — all four methods advertised (chooser appears)", {
    id: "pasqal-cloud",
    state: "needs-key",
    auth_methods: ALL_METHODS,
  }),
  fixture("waiting-browser — attempt lives in the user's browser", {
    id: "pasqal-cloud",
    state: "waiting-browser",
    auth_methods: ALL_METHODS,
  }),
  fixture("waiting-code — short code typed on any device", {
    id: "pasqal-cloud",
    state: "waiting-code",
    auth_methods: ALL_METHODS,
    user_code: "HRMQ-4321",
    verification_url: "https://pasqal.cloud/activate",
    code_expires_at: "2026-07-21T21:00:00.000Z",
  }),
  fixture("choose-project — authenticated, one choice left", {
    id: "pasqal-cloud",
    state: "choose-project",
    identity: "kate@harmoniqs.co",
    projects: PROJECTS,
  }),
  fixture("choose-project without wire projects — cancel exit stays open", {
    id: "pasqal-cloud",
    state: "choose-project",
    identity: "kate@harmoniqs.co",
  }),
  fixture("connected", {
    id: "pasqal-cloud",
    state: "connected",
    identity: "kate@harmoniqs.co",
    devices: [{ id: "fresnel", name: "Fresnel QPU" }, { id: "emu-free", name: "EMU_FREE" }],
    validated_at: "2026-07-21T10:00:00.000Z",
  }),
  fixture("expired — re-entry cost differs per method (copy carries it)", {
    id: "pasqal-cloud",
    state: "expired",
    auth_methods: ALL_METHODS,
    identity: "kate@harmoniqs.co",
  }),
  fixture("validating — one awaited POST, form frozen", {
    id: "pasqal-cloud",
    state: "validating",
    auth_methods: ALL_METHODS,
  }),
  fixture("offline — last verified, never a false invalid", {
    id: "pasqal-cloud",
    state: "connected",
    identity: "kate@harmoniqs.co",
    offline: true,
    validated_at: "2026-07-21T08:00:00.000Z",
  }),
  fixture("unknown wire state — safe fallback keeps every exit open", {
    id: "pasqal-cloud",
    state: "quantum-flux",
  }),
]

export const StateAtlas = () => (
  <div class="flex flex-col gap-4 max-w-96">
    <For each={MATRIX}>
      {(entry) => (
        <div class="flex flex-col gap-1">
          <div class="text-11-regular text-text-weaker">{entry.title}</div>
          <div class="border border-border-weak-base rounded-md py-1">
            <AmicodeConnectionsTab
              view={entry.view}
              labels={LABELS}
              {...noop}
              onStartAuth={() => {}}
              onChooseProject={() => {}}
              onCancelAuth={() => {}}
            />
          </div>
        </div>
      )}
    </For>
  </div>
)

/** Clickable walk-through: start a method → mid-flow → project → connected.
 *  The story fakes the server by swapping wire fixtures on each action. */
export const InteractiveWalkthrough = () => {
  const [entry, setEntry] = createSignal({ id: "pasqal-cloud", state: "needs-key", auth_methods: ALL_METHODS })
  const view = () => parseConnectionsResponse({ ok: true, connections: [entry()] })
  const advance = (state, extra = {}) => setEntry({ id: "pasqal-cloud", auth_methods: ALL_METHODS, state, ...extra })
  return (
    <div class="flex flex-col gap-2 max-w-96">
      <div class="border border-border-weak-base rounded-md py-1">
        <AmicodeConnectionsTab
          view={view()}
          labels={LABELS}
          onSubmit={async () => {
            advance("validating")
            setTimeout(() => advance("choose-project", { identity: "kate@harmoniqs.co", projects: PROJECTS }), 900)
            return { ok: true }
          }}
          onDisconnect={() => advance("needs-key")}
          onRevalidate={() => {}}
          onRetry={() => {}}
          onStartAuth={(payload) => {
            if (payload.method === "browser") {
              advance("waiting-browser")
              setTimeout(() => advance("choose-project", { identity: "kate@harmoniqs.co", projects: PROJECTS }), 2200)
            } else {
              advance("waiting-code", {
                user_code: "HRMQ-4321",
                verification_url: "https://pasqal.cloud/activate",
                code_expires_at: "2026-07-21T21:00:00.000Z",
              })
              setTimeout(() => advance("choose-project", { identity: "kate@harmoniqs.co", projects: PROJECTS }), 2200)
            }
          }}
          onChooseProject={() =>
            advance("connected", { identity: "kate@harmoniqs.co", validated_at: new Date().toISOString() })
          }
          onCancelAuth={() => advance("needs-key")}
        />
      </div>
      <div class="text-11-regular text-text-weaker">
        Pick a method, hit its action, watch the flow — the story fakes the server.
      </div>
    </div>
  )
}
