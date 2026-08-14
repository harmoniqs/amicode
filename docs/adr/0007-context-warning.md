# Proactive context-window warning (banner + header indicator)

Status: accepted (2026-08-14)

Tracking: harmoniqs/amicode#376 · harmoniqs/opencode#203

**Problem:** `SessionContextUsage` 16px ring lived only in the `Context` tab — invisible during normal flow. When `ContextOverflowError` fired ( `opencode/src/session/overflow.ts: usable = context - reserved` ), the only action was `compact session` with no prior warning, often capturing incorrectly.

**Fix:** promote indicator + threshold banner in the fork (extension has zero context logic):

- Header: `SessionContextUsage` always visible in `SessionHeaderV2Actions` (was tab-only), color `75-90%` amber, `>=90%` red pulse.
- Hook `use-context-warning.ts` (75% warn, 90% critical via `getSessionContext`), dismissible warn per session.
- Banner `context-warning-banner.tsx` 28px under `SessionHeader` (`session.tsx`): 75% amber dismissible `[Compact] [×]` + one-time toast, 90% red `[Compact]` + toast. Gives proactive compact before hard error.
- i18n `context.warning.*`.

Vendor bump will carry `opencode#203`. No amicode extension chrome change required.
