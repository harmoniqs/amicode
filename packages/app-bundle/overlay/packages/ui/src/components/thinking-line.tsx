// AMICODE: re-export shim so packages/app can import the thinking line through
// the existing `"./*": "./src/components/*.tsx"` export wildcard without touching
// packages/ui/package.json. Logic lives in ../amicode/thinking-line.tsx.
export { ThinkingLine } from "../amicode/thinking-line"
