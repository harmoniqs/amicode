# test/ is deliberately OUT of the scan (#1002): a symbol found only here is
# exactly what the report should surface for human judgment (precision over
# recall — the module's stated doctrine).
struct TestOnlyWidget
    n::Int
end
