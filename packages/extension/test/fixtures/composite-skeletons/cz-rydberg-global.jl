# Golden skeleton (spec-20260709 §5): composite Rydberg CZ (global drive) → GlobalRydbergSystem.
#   components: [{r1: atom, 3}, {r2: atom, 3}]
#   couplings:  [{between: [r1,r2], kind: vdW}]
#   drive:      { arch: global }
# Snapshot-checked, NOT executed. Free tier / unvetted (Piccolissimo path when entitled).
using Piccolo

sys = GlobalRydbergSystem(
    n_atoms = 2,
    subsystem_levels = [3, 3],          # 3-level ladder per atom (|0>,|1>,|r>) — leakage-aware
    # C6/r^6 from the vdW coupling params; global Ω,Δ drive (no per-atom addressing)
)

U_goal = EmbeddedOperator(:CZ, sys)     # CZ on {|0>,|1>}^2

# free_phase = N = 2 — CZ up to virtual-Z rotations (the honest primary metric for entanglers)
prob = UnitarySmoothPulseProblem(sys, U_goal, N, Δt; free_phase = true)
solve!(prob)
