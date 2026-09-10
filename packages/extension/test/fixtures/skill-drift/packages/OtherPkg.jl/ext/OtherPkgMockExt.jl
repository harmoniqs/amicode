# Package extensions are public API in modern Julia (#1002) — the scan must
# cover ext/ alongside src/. This symbol exists ONLY here, nowhere in src/.
struct ExtOnlyWidget
    n::Int
end
