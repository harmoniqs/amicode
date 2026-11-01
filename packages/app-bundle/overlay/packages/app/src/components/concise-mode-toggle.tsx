// amicode: concise-mode toggle for the v2 composer's bottom control row.
// A real switch (not an icon) — flipping it does NOT send a message; it sets a
// persistent per-session flag that, while on, attaches a concise directive to
// the NEXT message you send (as the invisible per-turn system instruction), so
// the response comes back concise. Turning it off stops that. The switch's own
// accent/checked styling (switch-v2.css) carries the on state; the "Concise"
// label is self-explanatory, so there is no tooltip.
import { Switch } from "@opencode-ai/ui/v2/switch-v2"

export function ConciseModeToggle(props: { active: boolean; disabled?: boolean; onToggle: (next: boolean) => void }) {
  return (
    <Switch
      data-action="concise-mode"
      checked={props.active}
      disabled={props.disabled}
      onChange={(next) => props.onToggle(next)}
    >
      Concise
    </Switch>
  )
}
