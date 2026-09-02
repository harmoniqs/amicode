// amicode#663: pure helpers for the type-grouped project selector.
// Extracted so the grouping + icon-mapping logic is testable without a DOM.

import type { ProjectAvatarStyle } from "@opencode-ai/ui/v2/project-avatar-v2"

export type ProjectType = "research" | "dev"

export interface ProjectTypeStyle {
  icon: "flask" | "code-brackets"
  variant: ProjectAvatarStyle
}

/** Map a project type to its icon name and avatar color variant. */
export function projectTypeStyle(type: ProjectType): ProjectTypeStyle {
  if (type === "research") return { icon: "flask", variant: "yellow" }
  return { icon: "code-brackets", variant: "blue" }
}

export interface TypedProject {
  type?: ProjectType
  [key: string]: unknown
}

export interface ProjectGroup<T extends TypedProject> {
  label: string
  type: ProjectType
  projects: T[]
}

/**
 * Group a flat list of typed projects into Research-first, Dev-second sections.
 * If all projects share the same type (or none have a type), returns an empty
 * array — the caller should render a flat list instead.
 */
export function groupProjectsByType<T extends TypedProject>(projects: T[]): ProjectGroup<T>[] {
  const research = projects.filter((p) => p.type === "research")
  const dev = projects.filter((p) => p.type === "dev")
  // Only section when both groups are non-empty.
  if (research.length === 0 || dev.length === 0) return []
  return [
    { label: "Research", type: "research", projects: research },
    { label: "Development", type: "dev", projects: dev },
  ]
}
