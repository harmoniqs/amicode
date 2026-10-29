# First task — the shakedown exercise (declared; NOT yet run)

**The task:** filter-function validation against synthetic noise spectra —
compute the filter response for a representative filter-function family
against declared synthetic spectra, fold the verdict with confidence
intervals (the estimation payload) end-to-end through the loop, tier-labeled
T1b. The synthetic ground truth is declared up front: the harness compares
deterministically over it.

**Exercise level: shakedown** — loop plumbing on synthetic substrate; it
certifies the pack's mechanics, not the domain's real capability.
Substrate-touching exercise (real NV data) is the tracked next milestone —
the NV testbed is not wired in this build, stated plainly.

**Exit:** the run exists with a run ID, a tier-labeled verdict with CIs,
and the artifacts intact — then this pack is EXERCISED (shakedown), and this
declaration updates to point at the run.
