// AMICODE: re-export shim so packages/app can import the brain engine
// through the existing `"./*": "./src/components/*.tsx"` export wildcard
// without touching packages/ui/package.json. Logic lives in
// ../amicode/brain-engine.ts.
export * from "../amicode/brain-engine"
