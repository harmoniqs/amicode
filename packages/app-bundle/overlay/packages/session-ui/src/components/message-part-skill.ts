/** Extract the human-readable body of a skill tool result: the SKILL.md
 *  instructions without the <skill_content>/<skill_files> transport wrapper
 *  and the model-facing plumbing lines (base-directory, relative-path note,
 *  sampling note, the "# Skill: name" heading the chip already shows). */
export function skillBody(output: string | undefined): string {
  if (!output) return ""
  const withoutFiles = output.replace(/<skill_files>[\s\S]*?<\/skill_files>/g, "")
  const drop = [
    /^<skill_content\b[^>]*>$/,
    /^<\/skill_content>$/,
    /^# Skill: .*$/,
    /^Base directory for this skill: .*$/,
    /^Relative paths in this skill .*$/,
    /^Note: file list is sampled\.$/,
  ]
  return withoutFiles
    .split("\n")
    .filter((line) => !drop.some((re) => re.test(line.trim())))
    .join("\n")
    .trim()
}
