// AMICODE: re-export shim (the `"./*": "./src/components/*.tsx"` wildcard) —
// the session timeline registers the approval bridge directly (#1818: the
// entity rail that used to own the registration was removed with the
// deprecated research surfaces; the approval card + ledger transport stay
// live). Logic lives in ../amicode/approval-bridge.ts.
export { registerAmicodeApprovalBridge } from "../amicode/approval-bridge"
