# opencode's XDG paths are its home; ~/.amico/ is Amicode's product state; they do not cross

Status: accepted (2026-08-25)

opencode's config (`~/.config/opencode/`), data (`~/.local/share/opencode/`), and session DB live
at their XDG defaults and are never redirected by Amicode except via the explicit user-controlled
`amicode.sessionDatabase` and `amicode.configDir` settings. Amicode's own product state —
profile, vaults, runs, problems, ops, entitlements, and the managed canonical binary — lives
under `~/.amico/`. Nothing crosses the boundary by default.

The opencode TUI (`opencode` the upstream ncurses CLI) is installed as a fallback at
`~/.local/bin/opencode` — a symlink into the managed canonical binary at
`~/.amico/opencode/canonical/current/opencode`, with the VSIX-vendored bootstrap as the target on
first boot before the updater runs. Placed idempotently by extension activation and `install.sh`.
Because the TUI reads the same XDG defaults as the Amicode chat server, sessions and provider
config are shared by construction — no configuration required.

**Why not redirect everything to `~/.amico/`:** the XDG paths are what the upstream opencode TUI
reads with no env injection. Unconditionally redirecting them would require `OPENCODE_DB` and
`OPENCODE_CONFIG_DIR` on every spawn — and would make a plain `opencode` invocation outside
Amicode's control (raw terminal, scripts, CI) silently miss the data. The XDG defaults are the
zero-config sharing contract between the Amicode chat panel and the TUI.

**The injection rule:** `amicode.sessionDatabase` and `amicode.configDir`, when set, must be
injected into both the server spawn env and the Amicode Terminal env — not just one. Injecting
into only the server creates a divergence where the TUI sees different sessions than the chat
panel. These two settings are the only governed injection point for `OPENCODE_DB` and
`OPENCODE_CONFIG_DIR`; no other code path may inject them.

**Note on the design history:** an earlier position in the design session was to remove these
settings entirely (closing the divergence by making redirection impossible). That position was
reversed: the settings are load-bearing for fleet and power users, and removing them would be a
regression. The correct fix is injecting them consistently into both consumers, not removing the
capability.

**Consequence:** `stageOpencodeCliLink()` must be called both at extension activation (for the
initial placement) and from the updater's post-adoption success path (to flip the symlink from the
vendored bootstrap to the managed canonical binary after the first successful update). A symlink
write failure is logged and skipped — it never blocks server activation.

Implementation: harmoniqs/amicode#556
