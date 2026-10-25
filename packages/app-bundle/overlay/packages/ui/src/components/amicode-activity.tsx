// AMICODE: re-export shim so packages/app can import the activity vocabulary
// through the existing `"./*": "./src/components/*.tsx"` export wildcard.
export {
  ACTIVITY_COLOR,
  ACTIVITY_SOFT,
  connectionActivity,
  lspActivity,
  mcpActivity,
  runActivity,
} from "../amicode/activity"
export type { Activity } from "../amicode/activity"
export { ActivityDot } from "../amicode/activity-dot"
