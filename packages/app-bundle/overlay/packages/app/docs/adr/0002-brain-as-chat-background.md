# 0002 — The Brain becomes the Chat's living background; components float on legibility-floored glass

- Status: Superseded by ADR 0003 (direction parked 2026-07-26; the Brain moved to the
  context-tree top panel instead of becoming the chat background)
- Date: 2026-07-24
- Deciders: Kate Bonner (Head of Product)
- Tracking: harmoniqs/opencode#56

## Context

The amico **Brain** — the data-true, live map of a session's thought — currently renders
as an inline strip *inside* the message timeline (a native canvas engine; the `/brain.html`
iframe was already retired). It is one row among many, easy to scroll past, and it competes
with the messages rather than framing them.

An earlier redesign (`kate/chat-brain-atmosphere`, six commits, never pushed or merged)
explored promoting the Brain to a chat-wide background behind *tiered per-bubble glass*
("atmosphere"), reaching a resolved design and a Phase-5 build. Kate reopened the design
fresh rather than continuing that branch. The open question: does the Brain stay an inline
timeline element, or become the **permanent background of the Chat** with every component
floating on frosted glass — and if so, how is legibility *guaranteed* when text sits on a
translucent surface over a moving graph? "Movement comes through" (translucency) and
"highly legible" (contrast) are in direct tension, and the earlier build hit exactly one
legibility failure: muted grey text not clearing WCAG-AA on its most translucent tier.

This decision governs the **Amicode app UI** (the opencode fork). It sits under ADR 0001
(chat-first shell): the Chat is the one persistent hub, and this ADR settles what the Chat
*looks like*.

## Decision

**The Brain becomes the permanent, full-bleed background of the Chat** — Landing,
conversation, and composer all sit on it. There is **one Brain**: the inline timeline strip
is absorbed into the background (one render loop, promoted from a timeline row to the room).
The **Rail, titlebar, and Panels stay solid**, framing the living pane. The Brain is a fixed,
viewport-anchored backdrop; cards scroll over a stationary Brain.

**Every chat component floats as a frosted-glass card, and legibility is guaranteed by
construction — not by eye:**

- **Blur** — a *high, constant* gaussian blur on every card. It provides perceptual calm and
  kills the high-frequency motion detail that hurts reading. It is cheap (no per-frame logic)
  and it is *not* what makes text legible.
- **Tint** — contrast comes entirely from a tint whose **opacity is pinned to clear the WCAG-AA
  floor (with a small safety margin, not exactly at the floor) over a fixed reference frame** —
  a synthetic Brain at peak bloom in which the sampled backdrop is the brightest palette value
  **the Brain actually paints in that theme** (peak `#fff676` on dark; peak `#8f8000` on light —
  the light-mode Brain never paints `#fff676`, so validating against it there would derive a
  near-transparent tint that silently fails over the real light frame). Blur smooths the backdrop but does not darken it; a card over a bright-yellow
  cluster is still on bright yellow until the tint pulls the composite toward the ink. The tint
  set is **keyed to the chat's own theme** — the chat runs a theme independent of the app shell
  (default oc-2) — so a chat-theme change re-keys the Glass and re-validates contrast. **Two
  tints:** *standard* (prose, bubbles, composer) holds body text ≥4.5:1; *dense* (code, diffs,
  run-plots) is more opaque and holds code/diff text ≥4.5:1 and graphical marks — syntax colors,
  diff fills, plot lines — ≥3:1 (WCAG 1.4.11), so colored content stays crisp.

**The Brain is data-true with an adaptive heartbeat.** Nodes light up as amico reads files,
runs tools, and touches the vault; the graph grows with the conversation, **densifying in place
within the fixed, viewport-anchored frame** — bounded by a node cap / recency window so a long
session neither scrolls the Brain nor grows its per-frame cost without limit. Motion follows
activity: a lively tempo when amico is working, ~8fps breathing at rest, and a **hard pause**
when the window is hidden or `prefers-reduced-motion` is set. At rest it shows a **sparse
seed** — a near-empty Landing whose graph grows *only* from the current session's real
thought, with **no cross-session persistence** (a fresh session opens nearly empty). One Brain
per window shows the **active** session; switching the titlebar session tab swaps the Brain to
that session's graph.

**Pre-agreed perf fallback (non-negotiable mid-build):** the frosted look is protected. At
rest, full blur and full motion always apply. A frame-time monitor trips the ease when p95
frame time stays over budget for a sustained window (with hysteresis before restoring, to
avoid oscillation): the Brain's *motion* eases (calm/slow) and returns to full tempo at rest.
If easing motion to a full stop still misses budget, the Brain **hard-pauses to a static
blurred field** — the terminal valve — but **blur fidelity never degrades.**

**Build by reuse.** A new, well-named branch off `local/amicode` reuses the de-risked native
plumbing — the native Brain engine, the glass-token generator, and the mount wiring from the
earlier branch (design-neutral, already hardened by an adversarial port-fidelity review) — and
builds the *design* layer fresh. No iframe. Both light and dark themes are first-class from day
one.

See `packages/app/CONTEXT.md` for the new vocabulary (**Brain**, **Glass**).

## Consequences

- The **inline brain strip** is retired as a timeline row; the timeline keeps only its text
  shimmer (the existing working indicator — the cycling gerund + live elapsed shown while a turn
  works). One Brain, one render loop.
- **No node-level interactivity is lost.** The strip's only affordance was a click-to-expand/
  collapse toggle (it was a collapsible row); the Brain engine has no node hit-testing. As an
  always-present background the expand toggle is obviated, not removed from a capable surface.
- When a solid **Panel** covers the Chat, the Brain need not animate behind the occluded area —
  a cheap perf saving, since Panels are opaque.
- The *standard* tint's opacity is **bounded below** by the contrast floor — it cannot be made
  ultra-transparent, or muted grey text fails AA over the reference frame (the exact
  failure the earlier build hit). Secondary/muted text therefore rides the *dense* tint or a
  locally-dimmed zone.
- The Chat's cost profile changes: high-radius backdrop-blur recomputed per frame over an
  animating canvas, across many cards, while scrolling, is the expensive combination. It must
  pass a **laptop-webview 60fps gate** (the real target — headless Chromium is only a proxy);
  the motion-ease fallback is the release valve.
- The **Rail, titlebar, and Panels are deliberately excluded.** Nav chrome stays rock-solid,
  and dense Panel lists (Chats history, Run gallery) don't fight a moving background.
- The Landing (a fresh, empty Chat per ADR 0001) now opens on the sparse-seed Brain rather
  than a blank surface — the window's first impression is the living background, calm and
  nearly empty, not a widget wall.

## Alternatives considered

- **Keep the inline brain strip** (a timeline row). Rejected: it is one element among many;
  the redesign's intent is the Brain as the room, not a row.
- **One calm reading lane / unified glass sheet** (Brain only in the margins). Rejected in
  favor of per-component floating cards — motion lives in the gaps between cards, which is
  where "movement comes through" *without* the cards themselves having to be see-through to it.
- **Dynamic contrast glass** (each card samples its backdrop per frame and adapts its tint).
  Rejected: per-frame readback is the biggest perf risk and AA is hard to prove against every
  frame; the static AA-floor tint is deterministic and cheap.
- **Quiet zone behind cards** (dim/slow the Brain under each card's footprint via per-card
  masking). Rejected: real engine complexity for translucency the gaps already provide.
- **Breathing skeleton atlas at rest** (the full latent graph, dim, breathing). Rejected in
  favor of the sparse seed — calmer, more literal, and it lets the floating cards dominate.
- **Protect motion and ease blur under load**, or **degrade only while scrolling**. Rejected:
  the frosted look is the aesthetic being protected; motion is the acceptable give under load.
- **Rebuild the engine clean**, or **evolve the old `kate/chat-brain-atmosphere` branch**.
  Rejected: reuse the de-risked plumbing (including its already-fixed port defects), but build
  the design fresh on a new branch rather than inherit the old design structure or re-pay for
  the engine port.
