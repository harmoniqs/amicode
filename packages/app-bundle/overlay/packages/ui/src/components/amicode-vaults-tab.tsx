// AMICODE: re-export shim so packages/app can import the vaults tab through
// the existing `"./*": "./src/components/*.tsx"` export wildcard without
// touching packages/ui/package.json. Logic lives in ../amicode/vaults-tab.tsx.
export { AmicodeVaultsTab, AMICODE_MANAGE_VAULTS_PROMPT } from "../amicode/vaults-tab"
export { parseVaultsResponse, type VaultsView } from "../amicode/vaults"
