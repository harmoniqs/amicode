import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const workflow = (name: string) => readFileSync(path.join(root, ".github", "workflows", name), "utf8");

describe("release workflow payload integrity", () => {
  it("keeps fork provisioning in candidate preparation and promotes from the tagged payload", () => {
    const candidate = workflow("prepare-release-candidate.yml");
    const release = workflow("release.yml");
    const promote = workflow("promote.yml");

    expect(candidate).toContain("REPO_ACCESS_TOKEN");
    expect(candidate).toContain("Preflight fork credential");
    expect(candidate).toContain("OPENCODE_CHANNEL=beta");
    expect(candidate).toContain('"client_payload[ref]=$SHA"');
    expect(candidate).not.toContain('"repos/$FORK_REPO/git/refs"');

    expect(release).not.toContain("REPO_ACCESS_TOKEN");
    expect(release).not.toContain("AMICODE_RELEASE_TAG");
    expect(release).not.toContain("actions/upload-artifact");
    expect(release).not.toContain("publish-marketplace:");
    expect(release).toContain("Publish to VS Code Marketplace");

    expect(promote).toContain('gh workflow run release.yml --ref "$CLEAN" -f tag="$CLEAN"');
  });
});
