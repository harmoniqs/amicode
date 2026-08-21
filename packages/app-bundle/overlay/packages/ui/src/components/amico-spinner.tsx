// AMICODE: re-export shim so packages/app can import the spinner through the
// existing `"./*": "./src/components/*.tsx"` export wildcard without touching
// packages/ui/package.json. Logic lives in ../amicode/spinner.tsx.
export { AmicoSpinner, AmicoMark } from "../amicode/spinner"
