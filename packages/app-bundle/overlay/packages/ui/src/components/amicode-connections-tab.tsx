// AMICODE: re-export shim so packages/app can import the connections tab
// through the existing `"./*": "./src/components/*.tsx"` export wildcard
// without touching packages/ui/package.json. Logic lives in
// ../amicode/connections-tab.tsx and ../amicode/connections.ts.
export { AmicodeConnectionsTab, ConnectionCard, type ConnectionsTabLabels } from "../amicode/connections-tab"
export {
  applyConnectionOverlay,
  COMPANY_COMPUTE_ID,
  parseConnectionActionResponse,
  parseConnectionsResponse,
  statusTabConnections,
  type ChooseProjectPayload,
  type ConnectionActionView,
  type ConnectionAuthMethod,
  type ConnectionOverlay,
  type ConnectionsView,
  type ConnectionView,
  type CredentialSubmitPayload,
  type StartAuthPayload,
} from "../amicode/connections"
