// AMICODE: re-export shim so packages/app can import the brain-ref mapper
// through the existing `"./*": "./src/components/*.tsx"` export wildcard
// without touching packages/ui/package.json. Logic lives in
// ../amicode/brain-ref.ts.
export * from "../amicode/brain-ref"
