// AMICODE (widget kernel): the security seam — which server paths and host
// actions a sandboxed widget may reach through the bridge. Exact route match
// or route + "?" query; no bare-prefix rides (/amicode/problem-x must NOT
// pass via /amicode/problem). Pure, unit-tested.

const FETCH_ROUTES = [
  "/amicode/profile",
  "/amicode/problems",
  "/amicode/problem",
  "/amicode/campaigns",
  "/amicode/campaign",
  "/amicode/run-status",
  "/amicode/run-series",
  "/amicode/run-cards",
  "/amicode/library",
  "/amicode/widgets",
  "/amicode/dashboard",
] as const

const ACTION_VERBS = [
  "resume-session",
  "save-profile",
  "lookup-institution",
  "resolve-logo",
  "open-external",
  "upload-library",
  "open-gallery",
  "warm-start",
] as const

export type ActionVerb = (typeof ACTION_VERBS)[number]

export function allowFetch(path: unknown): path is string {
  if (typeof path !== "string") return false
  return FETCH_ROUTES.some((route) => path === route || path.startsWith(route + "?"))
}

export function allowAction(verb: unknown): verb is ActionVerb {
  return typeof verb === "string" && (ACTION_VERBS as readonly string[]).includes(verb)
}
