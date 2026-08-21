// AMICODE: re-export shim so packages/app and packages/session-ui can import the
// tool card through the existing `"./*": "./src/components/*.tsx"` export
// wildcard without touching packages/ui/package.json. Logic lives in
// ../amicode/card.tsx.
export { AmicodeToolCard, AmicoSkillChip } from "../amicode/card"
