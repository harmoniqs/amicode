# Not exported — present in source only (the source-scan lane of symbol checking).
struct EmbeddedOperator
    op::Matrix{ComplexF64}
end

helper_thing(x) = 2x

# Non-exported bang function (#1002): `\b…!\b` can never match `reset_widget!(w)`
# (! is non-word, so no boundary before `(`) — the regression shape for the
# lookaround boundary fix.
function reset_widget!(w)
    return w
end
