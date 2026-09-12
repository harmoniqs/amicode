# Reconfigurable titlebar controls via per-button portals and edit mode

Status: proposed

Tracking: harmoniqs/amicode#684

The five titlebar controls (Sessions, Status, Side Panel, Profile, Settings) are user-reorderable across two slots -- left of tab strip and right of tab strip -- via drag-and-drop in an explicit edit mode. Each session-scoped button gets its own portal mount point (`#opencode-titlebar-{id}`), replacing the shared `#opencode-titlebar-right`, so the titlebar can place each mount in whichever slot the user's config dictates without changing button ownership. Edit mode (entered from a right-click context menu, exited via checkmark or Escape) suppresses click behavior to separate drag from click intent.

**Considered:** always-draggable buttons with a long-press gesture (rejected: 36px titlebar height makes gesture discrimination unreliable; accidental rearrangement risk); centralized rendering with all buttons owned by the titlebar (rejected: couples the titlebar to session lifecycle it currently avoids; the portal pattern preserves the session/titlebar ownership boundary); a button registry for plugin extensibility (rejected: premature for five hardcoded buttons; the config-driven model is a stepping stone if a registry is ever warranted).
