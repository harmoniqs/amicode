// AMICODE: re-export shim so packages/app can import the boot splash through
// the existing `"./*": "./src/components/*.tsx"` export wildcard without
// touching packages/ui/package.json. Logic lives in ../amicode/splash.tsx.
export { AmicodeSplash } from "../amicode/splash"
