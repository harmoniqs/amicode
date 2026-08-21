// AMICODE: app-facing shim for the widget kernel (the app imports ui code
// only through src/components/*.tsx wildcard exports). Also re-exports the
// institution-lookup helpers the home page needs for the about-you widget's
// host actions — institution-lookup.ts is a .ts file, invisible to the
// wildcard, and the home-cards shim does not export it.
export { WidgetGrid } from "../amicode/widget-grid"
export type { WidgetHostCallbacks } from "../amicode/widget-frame"
export {
  parseWidgetsResponse,
  parseDashboardResponse,
  type WidgetInfo,
  type DashboardState,
  type DashboardEntry,
} from "../amicode/widget-schema"
export { resolveTokens, densityFor, densityForViewport, type Density } from "../amicode/widget-tokens"
export { suggestInstitutions, resolveBrandLogo } from "../amicode/institution-lookup"
