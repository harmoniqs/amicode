// amicode: concise-mode toggle for the v2 composer's bottom control row.
// A little icon-only toggle that turns Amico's `concise` output-shaping skill
// on/off by sending the skill's own toggle phrases ("concise mode" /
// "normal mode"). Icon-only: aria-pressed + a state-dependent label carry the
// meaning — color is never the only signal (design-system a11y rule). The ON
// state uses the accent selected-state tokens (--accent-fill-soft +
// --accent-edge), the same warmth/edge pattern as the other amicode selected
// surfaces — never a yellow foreground on light.
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import "./concise-mode-button.css"

export function ConciseModeButton(props: { active: boolean; disabled?: boolean; onToggle: () => void }) {
  const label = () => (props.active ? "Concise mode: on" : "Concise mode: off")
  return (
    <TooltipV2 placement="top" value={label()} inactive={props.disabled}>
      <IconButtonV2
        data-action="concise-mode"
        type="button"
        variant="ghost-muted"
        size="large"
        classList={{ "concise-mode-button--on": props.active }}
        icon={<IconV2 name="collapse" />}
        aria-label={label()}
        aria-pressed={props.active}
        disabled={props.disabled}
        onClick={() => props.onToggle()}
      />
    </TooltipV2>
  )
}
