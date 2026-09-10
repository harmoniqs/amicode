# The DEFINING end of the #1002 reexport fixture pair: exports a symbol that
# the reexporting package (ChainPkg.jl) never defines itself — a claim scoped
# to ChainPkg must resolve HERE through the using/@reexport chain.
module OriginPkg

export chain_origin_widget

chain_origin_widget() = 42

end
