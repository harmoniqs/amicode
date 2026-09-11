import * as path from "node:path";

export function resolvePreviewVisibleChildrenDirectory(root: string, relativeDirectory: string, workspaceRoots: readonly string[]) {
  if (!workspaceRoots.includes(root)) return { ok: false as const };

  const directory = path.resolve(root, relativeDirectory);
  if (directory !== root && !directory.startsWith(root + path.sep)) return { ok: false as const };

  return { ok: true as const, directory };
}
