// AMICODE: re-export shim for the in-chat run window (spec C) so packages/app
// can import it through the "./*": "./src/components/*.tsx" export wildcard.
// Logic lives in ../amicode/run-window.tsx.
export { RunWindow, parseRunSeriesResponse, type RunSeries, type RunSeriesView } from "../amicode/run-window"
