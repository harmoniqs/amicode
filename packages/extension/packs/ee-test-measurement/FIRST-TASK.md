# First task — the shakedown exercise (declared; NOT yet run)

**The task:** one non-QICK instrument class through the strumento device
schema against **mock instruments** — a signal-generator + spectrum-analyzer
fit cycle via the task-record seam: author a device instance for the bench
class (schema extension in scope this pass), run a fit cycle
(`instrumento fit lorentzian`-class) against a mock measurement, record the
task (manifest, progress stream, terminal result), and fold a **T1b,
tier-labeled verdict** (residuals against declared tolerance) end-to-end
through the loop.

**Exercise level: shakedown** — the loop plumbing end-to-end on synthetic
substrate. It certifies the pack's mechanics (schema → task record →
verdict → fold), not the domain's real capability. Substrate-touching
exercise (a real bench run) is the tracked next milestone, gated on
hardware access that is not wired in this build — stated, not assumed.

**The polyglot seam rides the same exercise:** the task record the mock run
produces is written by the Python task-record writer and read by a Julia
consumer — one round-trip exercising the contract's shape across languages.

**Exit:** the run exists with a run ID, a tier-labeled verdict, and the task
directory intact — then this pack is EXERCISED (shakedown), and this
declaration updates to point at the run.
