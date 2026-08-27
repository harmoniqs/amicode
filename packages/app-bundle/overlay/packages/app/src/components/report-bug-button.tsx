// amicode/opencode#116: the report-a-bug button for the v2 composer's bottom
// control row. Renders only when the amicode_bug_report=1 boot param is set —
// the CALLER (PromptInputV2Composer) owns that gate and passes `undefined` to
// the composer's trailingControl slot instead, so a gated-off button never
// shifts the row's layout. Icon-only: the aria-label + tooltip carry the
// meaning — color is never the only signal.
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2, type IconButtonV2Props } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { reportBug, type ReportBugModel } from "@/pages/session/composer/report-bug"
import "./report-bug-button.css"

export function ReportBugButton(props: {
  disabled?: boolean
  /** stories only: force a visual state */ state?: IconButtonV2Props["state"]
  model?: ReportBugModel
}) {
  return (
    <TooltipV2 placement="top" value="Report a bug" inactive={props.disabled}>
      <IconButtonV2
        data-action="report-bug"
        type="button"
        variant="ghost-muted"
        size="large"
        state={props.state}
        icon={<IconV2 name="bug" />}
        aria-label="Report a bug"
        disabled={props.disabled}
        onClick={() => reportBug(undefined, props.model)}
      />
    </TooltipV2>
  )
}
