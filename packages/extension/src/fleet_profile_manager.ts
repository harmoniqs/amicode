// Fleet Profile Manager — watches the profiles directory and pushes updates
// to the Fleet Panel. Handles CRUD commands from the webview.
//
// Part of #356 (Fleet Panel: Fleet Profiles CRUD).

import * as fs from "node:fs";
import * as vscode from "vscode";
import {
  listProfiles,
  writeProfile,
  deleteProfile,
  duplicateProfile,
  slugify,
  slugExists,
  validateProfile,
  PROFILES_DIR,
  type FleetProfile,
} from "./fleet_profiles";
import type { FleetPanelView, FleetProfileSummary } from "./fleet_panel";

export class FleetProfileManager {
  private watcher?: fs.FSWatcher;
  private panel: FleetPanelView;

  constructor(panel: FleetPanelView) {
    this.panel = panel;
    this.startWatching();
    this.pushProfiles();
  }

  /** Push the current profile list to the panel. */
  pushProfiles(): void {
    const profiles = listProfiles();
    const summaries: FleetProfileSummary[] = profiles.map((p) => ({
      slug: p.slug,
      name: p.profile.name,
      model: p.profile.model,
      variant: p.profile.variant,
    }));
    this.panel.postProfiles(summaries);
  }

  /** Handle a create-profile action from the webview. */
  handleCreate(payload: Record<string, unknown>): { ok: boolean; error?: string } {
    const name = String(payload.name ?? "");
    const slug = slugify(name);

    const profile: Partial<FleetProfile> = {
      name,
      model: String(payload.model ?? ""),
      variant: String(payload.variant ?? ""),
      base: String(payload.base ?? "pulse-designer"),
      task_type: String(payload.task_type ?? "interactive"),
      skills: Array.isArray(payload.skills) ? payload.skills.map(String) : [],
      gates: Array.isArray(payload.gates) ? payload.gates.map(String) : [],
      permissions: { bash: "allow", file_write: "allow" },
    };

    const errors = validateProfile(profile);
    if (errors.length > 0) return { ok: false, error: errors[0] };
    if (slugExists(slug)) return { ok: false, error: `Profile "${slug}" already exists` };

    writeProfile({ schema: 1, ...profile } as FleetProfile, slug);
    this.pushProfiles();
    return { ok: true };
  }

  /** Handle an edit-profile action from the webview. */
  handleEdit(payload: Record<string, unknown>): { ok: boolean; error?: string } {
    const slug = String(payload.slug ?? "");
    if (!slug || !slugExists(slug)) return { ok: false, error: "Profile not found" };

    const profile: FleetProfile = {
      schema: 1,
      name: String(payload.name ?? ""),
      model: String(payload.model ?? ""),
      variant: String(payload.variant ?? ""),
      base: String(payload.base ?? "pulse-designer"),
      task_type: String(payload.task_type ?? "interactive"),
      skills: Array.isArray(payload.skills) ? payload.skills.map(String) : [],
      gates: Array.isArray(payload.gates) ? payload.gates.map(String) : [],
      permissions: { bash: "allow", file_write: "allow" },
    };

    const errors = validateProfile(profile);
    if (errors.length > 0) return { ok: false, error: errors[0] };

    writeProfile(profile, slug);
    this.pushProfiles();
    return { ok: true };
  }

  /** Handle a duplicate-profile action from the webview. */
  handleDuplicate(payload: Record<string, unknown>): { ok: boolean; error?: string } {
    const slug = String(payload.slug ?? "");
    const newSlug = duplicateProfile(slug);
    if (!newSlug) return { ok: false, error: "Source profile not found" };
    this.pushProfiles();
    return { ok: true };
  }

  /** Handle a delete-profile action from the webview. */
  handleDelete(payload: Record<string, unknown>): { ok: boolean; error?: string } {
    const slug = String(payload.slug ?? "");
    if (!deleteProfile(slug)) return { ok: false, error: "Profile not found" };
    this.pushProfiles();
    return { ok: true };
  }

  /** Start watching the profiles directory for external changes. */
  private startWatching(): void {
    try {
      fs.mkdirSync(PROFILES_DIR, { recursive: true });
      this.watcher = fs.watch(PROFILES_DIR, () => {
        this.pushProfiles();
      });
    } catch {
      // Directory watch may fail on some systems; profiles still work via explicit refresh
    }
  }

  dispose(): void {
    this.watcher?.close();
  }
}

/** Register profile CRUD commands and the profile manager. */
export function registerFleetProfiles(
  ctx: vscode.ExtensionContext,
  panel: FleetPanelView,
): FleetProfileManager {
  const manager = new FleetProfileManager(panel);
  ctx.subscriptions.push({ dispose: () => manager.dispose() });

  ctx.subscriptions.push(
    vscode.commands.registerCommand("amicode.fleet.createProfile", (payload?: Record<string, unknown>) => {
      if (payload) {
        const result = manager.handleCreate(payload);
        if (!result.ok) void vscode.window.showErrorMessage(`Profile creation failed: ${result.error}`);
      }
    }),
    vscode.commands.registerCommand("amicode.fleet.editProfile", (payload?: Record<string, unknown>) => {
      if (payload) {
        const result = manager.handleEdit(payload);
        if (!result.ok) void vscode.window.showErrorMessage(`Profile edit failed: ${result.error}`);
      }
    }),
    vscode.commands.registerCommand("amicode.fleet.duplicateProfile", (payload?: Record<string, unknown>) => {
      if (payload) {
        const result = manager.handleDuplicate(payload);
        if (!result.ok) void vscode.window.showErrorMessage(`Profile duplication failed: ${result.error}`);
      }
    }),
    vscode.commands.registerCommand("amicode.fleet.deleteProfile", (payload?: Record<string, unknown>) => {
      if (payload) {
        const result = manager.handleDelete(payload);
        if (!result.ok) void vscode.window.showErrorMessage(`Profile deletion failed: ${result.error}`);
      }
    }),
  );

  return manager;
}
