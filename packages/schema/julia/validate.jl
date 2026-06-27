#!/usr/bin/env julia
# amico-validate, Julia side (0.1d). Validates a TOML artifact against the SAME
# shared JSON Schema files the TS validator uses — read DIRECTLY from
# ../schemas/*.json, never a transcribed copy (that single source is what makes
# the cross-language anti-drift guarantee real: mutate a schema → both sides flip).
#
# Usage:  julia --project=packages/schema/julia validate.jl <file> [kind]
#   kind inferred from basename for manifest.toml/result.toml/lab.toml/FINISHED.
# Exit:   0 valid · 64 invalid or usage error (mirrors amico-validate / amico-run).
module AmicoValidate

import TOML
import JSON
import Dates
using JSONSchema

const SCHEMA_DIR = normpath(joinpath(@__DIR__, "..", "schemas"))

kind_for_filename(path) = begin
    b = basename(path)
    b == "manifest.toml" ? "manifest" :
    b == "result.toml"   ? "result"   :
    b == "lab.toml"      ? "lab"       :
    b == "FINISHED"      ? "finished"  : nothing
end

load_schema(kind) = Schema(read(joinpath(SCHEMA_DIR, "$(kind).schema.json"), String))

# TOML → JSON-compatible: an UNQUOTED TOML datetime parses to a Dates type, which
# would fail `type: string` (format: date-time). Coerce to ISO-8601 so quoted and
# unquoted datetimes validate identically (matches the TS validateFile S2 fix).
jsonify(x) = x
jsonify(d::AbstractDict) = Dict(string(k) => jsonify(v) for (k, v) in d)
jsonify(a::AbstractVector) = Any[jsonify(v) for v in a]
jsonify(t::Dates.TimeType) = string(t)

# Shim JSONSchema.jl's SingleIssue into a field-precise message comparable to the
# TS side ("/path/to/key: reason"). Its `path` is like "[a][b]" or "" (root);
# `reason` is the failing keyword; `x` is the failing instance; `val` the schema
# fragment. For `required`/`enum` we reconstruct the offending key from x/val.
function format_issue(iss)
    p = replace(iss.path, "[" => "/", "]" => "")
    where = isempty(p) ? "(root)" : p
    if iss.reason == "required"
        missing = try
            present = Set(string.(keys(iss.x)))
            String[string(k) for k in iss.val if !(string(k) in present)]
        catch; String[]; end
        keys_txt = isempty(missing) ? "a required key" : join(["\"$k\"" for k in missing], ", ")
        return "$where: missing required key $keys_txt"
    elseif iss.reason == "additionalProperties"
        return "$where: unknown key"
    elseif iss.reason == "enum"
        endswith(where, "schema_version") && return "/schema_version: unrecognized version"
        return "$where: must be one of the allowed values"
    else
        return "$where: $(iss.reason)"   # type, maximum, minimum, …
    end
end

"""Validate `path` (TOML) against the shared schema for `kind`.
Returns `nothing` if valid, else a field-precise error String."""
function validate_file(path::AbstractString, kind::AbstractString)
    data = jsonify(TOML.parsefile(path))
    iss = JSONSchema.validate(load_schema(kind), data)
    iss === nothing ? nothing : format_issue(iss)
end

function main(args)
    if isempty(args) || args[1] in ("-h", "--help")
        println("usage: julia validate.jl <file> [kind]"); return isempty(args) ? 64 : 0
    end
    file = args[1]
    kind = length(args) >= 2 ? args[2] : kind_for_filename(file)
    if kind === nothing
        println(stderr, "amico-validate(jl): cannot infer schema for $file — pass a kind"); return 64
    end
    err = try
        validate_file(file, kind)
    catch e
        println(stderr, "amico-validate(jl): $file: $(sprint(showerror, e))"); return 64
    end
    if err === nothing
        println("OK $file ($kind)"); return 0
    else
        println(stderr, "INVALID $file ($kind):\n  $err"); return 64
    end
end

end # module

if abspath(PROGRAM_FILE) == @__FILE__
    exit(AmicoValidate.main(ARGS))
end
