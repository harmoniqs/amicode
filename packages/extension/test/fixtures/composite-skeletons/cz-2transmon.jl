# Golden skeleton (spec-20260709 §5): composite 2-transmon CZ → MultiTransmonSystem.
# Reference of the intended authoring output for a composite System of
#   components: [{q1: qubit, 3}, {q2: qubit, 3}]
#   couplings:  [{between: [q1,q2], kind: cross-resonance}]
#   drive:      { arch: per-component }
# Snapshot-checked (composite_skeletons.test.ts), NOT executed. Free tier / unvetted.
using Piccolo

sys = MultiTransmonSystem(
    n_qubits = 2,
    subsystem_levels = [3, 3],          # per-component levels from components[].levels
    # ω/δ per component from components[].params; g from the cross-resonance coupling params
)

# CZ on the {|0⟩,|1⟩}^2 computational subspace of the 3^2 Hilbert space
U_goal = EmbeddedOperator(:CZ, sys)

# free_phase = N = 2 (one virtual-Z per component) — entangling gate
prob = UnitarySmoothPulseProblem(sys, U_goal, N, Δt; free_phase = true)
solve!(prob)
