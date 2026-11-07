// AMICODE: re-export shim (the `"./*": "./src/components/*.tsx"` wildcard) —
// the session timeline registers the ask bridge directly (#1818: the entity
// rail that used to own the registration was removed with the deprecated
// research surfaces). Logic lives in ../amicode/ask-bridge.ts.
export { registerAmicodeAskBridge } from "../amicode/ask-bridge"
