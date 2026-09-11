# The REEXPORTING end of the #1002 reexport fixture pair: the reexported
# symbol is defined and exported by OriginPkg.jl — a claim scoped to ChainPkg
# must follow the @reexport chain to verify. `using Reexport` targets a
# package absent from the fixture roots: an undiscovered using adds nothing
# and never degrades a verdict.
module ChainPkg

using Reexport
@reexport using OriginPkg

end
