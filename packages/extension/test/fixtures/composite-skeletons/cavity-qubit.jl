# Golden skeleton (spec-20260709 §5): heterogeneous cavity+qubit → bosonic system.
#   components: [{q1: qubit, 2}, {cav: cavity, 12}]   # Fock truncation on the cavity
#   couplings:  [{between: [q1,cav], kind: dispersive-chi}]
#   drive:      { arch: per-component }
# Snapshot-checked, NOT executed. Free tier / unvetted; invoke the `bosonic` skill for the model.
using Piccolo

# Heterogeneous composite: qubit + cavity in the displaced/dispersive frame.
sys = CavityQubitSystem(
    subsystem_levels = [2, 12],         # qubit 2, cavity Fock cutoff 12 (per-component levels)
    # chi from the dispersive-chi coupling params
)

# Target on the computational subspace (state prep or a cavity operation)
U_goal = EmbeddedOperator(:target, sys)

# free_phase = N = 2 across the two subsystems
prob = UnitarySmoothPulseProblem(sys, U_goal, N, Δt; free_phase = true)
solve!(prob)
