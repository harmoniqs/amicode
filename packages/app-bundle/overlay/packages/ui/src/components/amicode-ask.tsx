// AMICODE: re-export shim (the `"./*": "./src/components/*.tsx"` wildcard) —
// the session timeline needs the ask staleness guard to register the ask
// bridge directly (#1818: the entity rail that used to register it was
// removed with the deprecated research surfaces). Logic lives in
// ../amicode/ask.ts.
export { hasUserReplyAfter, parseAskInput, type AskInput } from "../amicode/ask"
