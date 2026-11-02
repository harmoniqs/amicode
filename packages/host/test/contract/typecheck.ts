// Compile one file with the host's own tsconfig and return its diagnostics as strings. `overrides` replaces the text of
// named files (absolute, real paths) in memory, which is how the drill plants a type-level break in the published
// declarations without touching the install.
import path from "node:path"
import ts from "typescript"
import { packageRoot } from "./support.ts"

export function typeCheck(file: string, overrides: Record<string, string> = {}): string[] {
  const config = ts.readConfigFile(path.join(packageRoot, "tsconfig.json"), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageRoot)
  const options: ts.CompilerOptions = { ...parsed.options, noEmit: true, incremental: false, composite: false }
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (name, languageVersion, ...rest) => {
    const text = overrides[path.resolve(name)]
    return text === undefined ? getSourceFile(name, languageVersion, ...rest) : ts.createSourceFile(name, text, languageVersion)
  }
  const program = ts.createProgram([file], options, host)
  const source = program.getSourceFile(file)
  if (!source) return [`cannot load ${file}`]
  return [...program.getOptionsDiagnostics(), ...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)].map((diagnostic) => {
    const where = diagnostic.file && diagnostic.start !== undefined ? `${path.basename(diagnostic.file.fileName)}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1} ` : ""
    return where + ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
  })
}
