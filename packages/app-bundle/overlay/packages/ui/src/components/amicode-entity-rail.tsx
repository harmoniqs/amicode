// AMICODE: re-export shim so packages/app can import the entity rail through
// the existing `"./*": "./src/components/*.tsx"` export wildcard without
// touching packages/ui/package.json. Logic lives in ../amicode/entity-rail.tsx.
export { AmicodeEntityRail, sessionHasAmicodeParts } from "../amicode/entity-rail"
