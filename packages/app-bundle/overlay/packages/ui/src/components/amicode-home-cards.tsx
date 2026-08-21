// AMICODE: re-export shim so packages/app can import the home-screen cards
// through the existing `"./*": "./src/components/*.tsx"` export wildcard
// without touching packages/ui/package.json. Logic lives in
// ../amicode/home-cards.tsx.
export {
  AmicodeHomeCards,
  parseProfileResponse,
  type ProfileView,
  type ProfileYou,
  type ProfileStats,
  type HomeLiveRun,
} from "../amicode/home-cards"
