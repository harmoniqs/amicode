# Why spacing = the graph

On a neutral-atom array the graph is drawn by geometry: two atoms interact strongly
(the Rydberg *blockade*) when they sit closer than the blockade radius
$R_b = (C_6/\Omega)^{1/6}$ — those pairs are the graph's edges. Atoms farther apart
barely interact — no edge. So a graph is loadable exactly when you can place its
vertices in the plane with edges ⇔ distance < $R_b$ (a *unit-disk* graph).

Practical numbers (Rb, $C_6 \approx 5.42\times 10^6\ \mathrm{rad\,\mu m^6/\mu s}$):
9 μm neighbors interact at ~10 rad/μs (blockaded); 15.6 μm non-neighbors at
~0.4 rad/μs (negligible). The detuning sweep must end *between* the edge and
non-edge interaction scales — that's what makes the MIS the ground state. Keep the
scales soft: the optimizer's timestep budget grows with the largest energy in the
problem.
