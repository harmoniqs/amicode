// AMICODE: re-export shim (the `"./*": "./src/components/*.tsx"` wildcard) —
// the session timeline registers the ui bridge directly (#1818: the entity
// rail that used to own the registration was removed with the deprecated
// research surfaces; the LIVE transport it carried — the RunWindow's run-series
// fetch + the in-chat widget preview host — stays). Logic lives in
// ../amicode/ui-bridge.ts.
export { registerAmicodeUiBridge, type AmicodeUiBridge, type AmicodeWidgetHost } from "../amicode/ui-bridge"
