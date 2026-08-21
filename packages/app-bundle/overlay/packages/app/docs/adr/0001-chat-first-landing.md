# 0001 — Chat is the landing; the dashboard dissolves into a rail

- Status: Proposed
- Date: 2026-07-23
- Deciders: Kate Bonner (Head of Product)

## Context

The Amicode window opened on a **Home** page: a top chrome strip plus an aggregate grid
of widgets (run gallery, pulse bank, library, "about you", "now solving", "meet amico",
"jump back in"). Chat lived on a separate route the researcher navigated to. Reaching a
new chat therefore cost a step, and the first thing a researcher saw was a dashboard of
everything rather than an invitation to act.

The redesign already in flight on `kate/chat-redesign` had been pulling the new-session
screen toward a composer-as-hero, and auto-draft machinery to open an empty chat without
a session id already existed behind the `newLayoutDesigns` feature flag — though only
*inside* the directory-scoped session route, not at the root. The open question was
whether to keep the dashboard as a peer destination or commit to chat as the single hub.

## Decision

**The window lands on a fresh new chat on every launch, and the aggregate dashboard is
removed.** Chat becomes the one persistent hub. The widgets that earned a place are
re-homed onto a single vertical **Rail** of navigation surfaces (Chats · Projects · Run
gallery · Pulse bank · Library), with identity/config in an **Account zone** at the
Rail's foot. Each Rail surface opens a dismissible **Panel** beside the chat; the chat
is overlaid, never replaced, and at most one Panel is open at a time. Two widgets become
ambient: the running-solve readout becomes a **Live-solve indicator** in the titlebar,
and onboarding becomes a non-blocking **Setup nudge** on the first-run landing.

The change is shipped as a single coherent cutover under the existing `newLayoutDesigns`
flag — not behind a new flag and not sliced for incremental rollout. The flag remains
the fallback to the legacy shell.

See `packages/app/CONTEXT.md` for the vocabulary (Landing, Rail, Rail surface, Panel,
Account zone, Live-solve indicator, Setup nudge) and the retired concepts.

## Consequences

- The **Home** page, its **top chrome strip**, and the aggregate **Dashboard** are
  retired. The titlebar's `/`-pointing Home button is repurposed to "new chat"; the
  titlebar session tab strip stays (open sessions) alongside the Chats Rail surface
  (history). The `w-16` **project-avatar strip** is legacy-only and already absent when
  the flag is on. Older code and notes must map forward per `CONTEXT.md`.
- **The landing runs at `/`, which has no directory context**, unlike the existing
  session-route auto-draft. The root landing must resolve a working directory first —
  reusing the server-cwd fallback on a fresh install with no tracked project.
- **A shipped capability is retired:** dissolving the dashboard removes the home for the
  user-authored-widget subsystem (`amicode_author_widget`, pin-to-dashboard, the widget
  grid, `/amicode/dashboard`), so authoring and pinning are removed rather than re-homed.
  Existing pinned widgets stop appearing. Re-homing authored widgets as in-Chat artifacts
  is a possible future enhancement, deliberately out of this cutover.
- Fastest path to value: a researcher can type a prompt the instant the window opens.
- Discoverability of the collections (gallery, pulse bank, library) drops from
  "on screen by default" to "one Rail click away." Accepted, because the Rail's
  hover labels keep them nameable and the dashboard's density worked against focus.
- The server-driven widget data (`/amicode/*` routes) is reused; widgets are re-homed
  into Panels, not rebuilt.
- Onboarding must be usable ambiently — the conversational overture interview plus a
  Setup nudge — because there is no dashboard to host a setup wall.
- A single cutover means no partial state to maintain, but the whole shell changes at
  once under the flag; review and QA happen against the flag as one unit.

## Alternatives considered

- **Keep an optional Dashboard surface** (a Rail icon reopening the grid). Rejected:
  two ways to reach the same widgets, and it preserves the "dashboard of everything"
  the redesign is trying to shed.
- **Grid as the default rail panel** (a soft home beside the chat). Rejected: leaves a
  widget wall adjacent to the composer, undercutting "chat is the hero."
- **Resume the last chat on launch** instead of a fresh one. Rejected: makes the
  landing inconsistent (sometimes chat, sometimes stale context) and diverges from the
  reference; in-flight solves are recovered via the Live-solve indicator and the Chats
  surface instead.
- **Two-tier rail** (Slack-style persistent project avatars beside the function rail).
  Rejected: heavier chrome competing with the chat; the Projects surface covers fast
  switching at one click.
- **New `chatFirstLayout` flag with a 3-slice rollout**, or a **prototype-first**
  validation pass. Rejected for now in favor of one cutover under `newLayoutDesigns`;
  revisit if the single cutover proves too large to review.
