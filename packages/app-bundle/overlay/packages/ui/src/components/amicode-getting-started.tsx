// AMICODE: re-export shim so packages/app can import the getting-started block
// through the existing `"./*": "./src/components/*.tsx"` export wildcard
// without touching packages/ui/package.json. Logic lives in
// ../amicode/getting-started.tsx.
export {
  AmicodeGettingStarted,
  AmicodeStarterChips,
  AMICODE_STARTERS,
  type StarterChip,
} from "../amicode/getting-started"
