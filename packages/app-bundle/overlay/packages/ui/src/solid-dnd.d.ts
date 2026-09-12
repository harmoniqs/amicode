// @thisbeyond/solid-dnd's `use:sortable` directive typing (mirrors the app's
// env.d.ts declaration) — required for .tsx files in this package that render
// sortable elements (amicode/widget-grid.tsx).
declare module "solid-js" {
  namespace JSX {
    interface Directives {
      sortable: true
    }
  }
}

export {}
