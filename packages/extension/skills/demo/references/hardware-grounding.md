# Demo — Hardware grounding (device-faithful demos)

How to build a demo that mirrors a real device: the step-0 hardware research, the
`PLAN.md` design record and handoff pattern, and the stage-0 analytic validation that gates
all solves. Loaded on demand from [`../SKILL.md`](../SKILL.md). Read this before `/demo new`
when the demo targets a named device or platform (a company's chip, a published unit cell) —
skip it only for generic-physics demos.

The reader who matters is the skeptical evaluator holding the actual device:
their first question is *"are these our device's numbers?"*.
Literature composites and review-article defaults routinely fail that test — a "typical"
30 MHz micromagnet Rabi rate is wrong by 45× for a device whose antenna runs at 658.6 kHz,
and that error changes gate times, knot counts, and the entire solve regime.

## Step 0: hardware research (before any scaffolding)

Extract from the device's *own* publications (not reviews, not sibling devices):

| What to find | What it decides in the demo |
|---|---|
| Control modality (antenna ESR / micromagnet EDSR / gate pulsing) | the drive Hamiltonian — and which leakage channels exist at all |
| Quoted Rabi / gate times | drive amplitude bound $\Omega_\max$, hence $T$ and $N$ |
| Coherence ($T_1$, $T_2^*$, $T_2^\text{Hahn}$) | whether the closed-system model is honest at the chosen $T$ |
| Measured dominant error channel (GST error budgets, tracking residuals) | the robustness ensemble — sample *that* parameter at *that* spread |
| Control electronics (AWG granularity, I/Q modulation) | pulse parameterization (spline knots the hardware can actually render) |
| Virtual-$Z$ availability | `free_phase` on/off |
| The binding hardware constraint (heating, crosstalk) | the *shape* of the amplitude bound (see conventions.md) |

Rules:

- **Cite every constant inline** in `defaults.jl` with its source (paper + figure/table).
  A constant without a citation is a guess.
- Prefer the device's measured numbers over any composite; when the device's own papers
  disagree (flagship unit cell vs scaled array), take the flagship and note the range.
- Record what was searched and rejected — the wrong default's provenance matters as much
  as the right one's.

## `PLAN.md`: the design record

Hardware-grounded demos start with a `PLAN.md` at repo root, written before code. It must
carry:

1. **Hardware table** — every parameter with citation (the step-0 output).
2. **Model + conventions** — Hamiltonian, frame, units, and the exact drive-amplitude
   convention (see the tripwire below), with the numbers that pin it (e.g. "rectangular
   $\pi/2$ = 379.6 ns").
3. **Pulse/problem type rationale** — each choice traced to a hardware fact, not taste.
4. **Gate set + run topology** — staged scripts, one line each.
5. **Intended `src/` API** — function signatures per module, so implementation is mechanical.
6. **Stage-0 validation spec** — the analytic check, pass criterion, failure symptoms.
7. **Deferred items** — physics discussed and set aside, with the reason.
8. **Routing + caveats** — where solves run, what's unvetted, what verification is skipped.

### Handoff pattern (PLAN.md-first)

When someone else implements the demo (a teammate, a collaborator at the device company),
the deliverable is **scaffolding + `PLAN.md` — no scripts**: the directory tree, pinned
`Project.toml`/`Manifest.toml`, README pointing at the plan, docs stubs, `.gitkeep`s. The
design is complete; the implementation is mechanical; ownership is unambiguous. Register
the vault demo card with `status: planned` and the repo pointer, and flip it as stages land.

## Stage 0: analytic validation (gates all solves)

The first script in any hardware-grounded demo is a **simulation check against an analytic
result**, run before any optimization — generalizing the autonomous-plan pattern's
"validate before optimizing". For a driven qubit: roll a rectangular reference pulse and
compare the chevron against the analytic Rabi formula
$P_1(t) = (\Omega^2/\Omega_R^2)\sin^2(\Omega_R t/2)$, $\Omega_R = \sqrt{\Omega^2+\delta^2}$.

- **Pass criterion:** numerical agreement to solver tolerance *and* a known landmark at a
  known time (e.g. first chevron peak at 379.6 ns). Exit nonzero on failure.
- **The factor-of-2 tripwire:** with $H = (\Omega/2)\,\sigma_x$ the Rabi rate equals the
  quoted $\Omega/2\pi$; with $H = \Omega\,\sigma_x$ it doubles. If the landmark lands at
  *half* or *double* the expected time, the drive convention — not the physics — is wrong.
  Fix before any solve; an optimizer happily converges around a wrong Hamiltonian.
- **Trust anchor:** when solves run where independent re-rollout verification is skipped
  (e.g. cloud executors), stage 0 is the only check that the *model* — not the optimizer —
  is right. Say so in the run record.

Worked example of this whole reference: `diraq-esr-demo/PLAN.md` (ESR spin qubit grounded
in Diraq's Nature 2025 specs).
