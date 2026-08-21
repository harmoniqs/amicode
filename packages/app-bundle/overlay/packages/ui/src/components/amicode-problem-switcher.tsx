// AMICODE: re-export shim (the `"./*": "./src/components/*.tsx"` wildcard).
// The in-chat AMICO · Problems dialog was dropped in the ring-2 verdict-first
// redesign (a problem list is never the relevant in-chat surface — the archive
// lives in the run gallery). This shim survives only to expose the /amicode/
// problems wire parser still used by the start-screen / home problem lists.
export { parseProblemsResponse, type ProblemsView } from "../amicode/problem"
