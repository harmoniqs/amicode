// AMICODE: re-export shim (the `"./*": "./src/components/*.tsx"` wildcard) —
// the transcript model's self-heal edges. Extracted from the retired
// amicode-entity-view shim when the deprecated research surfaces were
// removed (#1818); logic lives in ../amicode/refetch-edge.ts.
export { shouldRefetchOnReconnect, shouldRefetchOnResync } from "../amicode/refetch-edge"
