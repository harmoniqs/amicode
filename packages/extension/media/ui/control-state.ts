// Pure enablement logic for the Run Inspector control row. No DOM — unit-tested
// in node; the view applies the result to button .disabled flags.

export type ControlStatus = "idle" | "warming" | "running" | "completed" | "failed" | "stopped";

export interface ControlEnablement {
  /** Stop only makes sense while the solve is live. */
  stop: boolean;
  /** Save needs pulse.jld2, which exists once ≥1 iteration/pulse has landed
   *  (hasData) or the run has finished. */
  save: boolean;
  /** Open the run dir whenever there is a run at all. */
  open: boolean;
}

export function controlEnablement(status: ControlStatus, hasData: boolean): ControlEnablement {
  const live = status === "warming" || status === "running";
  // A converged/stopped run has a pulse.jld2 worth saving; a failed run only if
  // it actually emitted data before dying.
  const producedPulse = status === "completed" || status === "stopped";
  return {
    stop: live,
    save: hasData || producedPulse,
    open: status !== "idle",
  };
}
