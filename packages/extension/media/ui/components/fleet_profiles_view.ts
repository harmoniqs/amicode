// Fleet Profiles view component — renders the profiles list in the Fleet Panel
// webview. Each row shows name + model/variant + play button + overflow menu.
// Inline form for create/edit.
//
// Part of #356 (Fleet Panel: Fleet Profiles CRUD).

import { defineStyle } from "../style";
import { button } from "../atoms/button";
import type { FleetWebviewMessage } from "../../../src/fleet_panel";

defineStyle(
  "fleet-profiles",
  `
  .profiles-list { display: flex; flex-direction: column; gap: var(--space-xs); }
  .profile-row { display: flex; align-items: center; gap: var(--space-sm);
                 padding: var(--space-xs) var(--space-sm);
                 border: var(--border-width) solid var(--border-color);
                 border-radius: var(--border-radius); background: var(--bg-box); }
  .profile-row .pr-name { font-weight: 600; flex: 1; overflow: hidden;
                          text-overflow: ellipsis; white-space: nowrap; }
  .profile-row .pr-model { color: var(--color-dim); font-size: var(--text-small);
                           flex: 0 0 auto; max-width: 120px; overflow: hidden;
                           text-overflow: ellipsis; white-space: nowrap; }
  .profile-row .pr-play { flex: 0 0 auto; cursor: pointer; background: none;
                          border: none; color: var(--color-ok); font-size: 14px;
                          padding: 2px 4px; }
  .profile-row .pr-play:hover { opacity: 0.8; }
  .profile-row .pr-menu { flex: 0 0 auto; cursor: pointer; background: none;
                          border: none; color: var(--color-dim); font-size: 14px;
                          padding: 2px 4px; position: relative; }
  .profile-row .pr-menu:hover { color: var(--vscode-foreground); }
  .profile-menu { position: absolute; right: 0; top: 100%; background: var(--bg-box);
                  border: var(--border-width) solid var(--border-color);
                  border-radius: var(--border-radius); z-index: 100; min-width: 100px;
                  box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
  .profile-menu-item { padding: var(--space-xs) var(--space-sm); cursor: pointer;
                       font-size: var(--text-small); white-space: nowrap; }
  .profile-menu-item:hover { background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent); }
  .profile-form { display: flex; flex-direction: column; gap: var(--space-xs);
                  padding: var(--space-sm); border: var(--border-width) solid var(--border-color);
                  border-radius: var(--border-radius); background: var(--bg-box); }
  .profile-form input, .profile-form select { font-family: var(--text-font);
                  font-size: var(--text-small); padding: var(--space-xs) var(--space-sm);
                  border: var(--border-width) solid var(--border-color);
                  border-radius: var(--border-radius); background: var(--vscode-input-background, transparent);
                  color: var(--vscode-foreground); }
  .profile-form label { font-size: var(--text-small); color: var(--color-dim); }
  .profile-form .form-row { display: flex; flex-direction: column; gap: 2px; }
  .profile-form .form-actions { display: flex; gap: var(--space-xs); margin-top: var(--space-xs); }
`,
);

export interface ProfileSummary {
  slug: string;
  name: string;
  model: string;
  variant: string;
}

export interface ProfilesView {
  el: HTMLElement;
  update(profiles: ProfileSummary[]): void;
}

export function createProfilesView(post: (msg: FleetWebviewMessage) => void): ProfilesView {
  const el = document.createElement("div");
  const list = document.createElement("div");
  list.className = "profiles-list";
  el.appendChild(list);

  // "+" button at the top
  const addBtn = button("+", () => showForm(null));
  addBtn.el.title = "Create new profile";
  el.insertBefore(addBtn.el, list);

  let formEl: HTMLElement | null = null;
  let currentMenu: HTMLElement | null = null;

  function dismissMenu(): void {
    if (currentMenu) {
      currentMenu.remove();
      currentMenu = null;
    }
  }

  document.addEventListener("click", () => dismissMenu());

  function showForm(editSlug: string | null, prefill?: ProfileSummary): void {
    hideForm();
    formEl = document.createElement("div");
    formEl.className = "profile-form";

    const fields = [
      { key: "name", label: "Name", value: prefill?.name ?? "" },
      { key: "model", label: "Model", value: prefill?.model ?? "anthropic.claude-opus-4-6-v1" },
      { key: "variant", label: "Variant", value: prefill?.variant ?? "" },
      { key: "base", label: "Base", value: "pulse-designer" },
      { key: "task_type", label: "Task Type", value: "interactive" },
      { key: "skills", label: "Skills (comma-separated)", value: "transmon, atoms, bosonic" },
    ];

    const inputs: Record<string, HTMLInputElement> = {};
    for (const f of fields) {
      const row = document.createElement("div");
      row.className = "form-row";
      const label = document.createElement("label");
      label.textContent = f.label;
      const input = document.createElement("input");
      input.type = "text";
      input.value = f.value;
      input.placeholder = f.label;
      inputs[f.key] = input;
      row.appendChild(label);
      row.appendChild(input);
      formEl.appendChild(row);
    }

    const actions = document.createElement("div");
    actions.className = "form-actions";

    const saveBtn = button(editSlug ? "Save" : "Create", () => {
      const payload: Record<string, unknown> = {
        name: inputs.name.value,
        model: inputs.model.value,
        variant: inputs.variant.value,
        base: inputs.base.value,
        task_type: inputs.task_type.value,
        skills: inputs.skills.value.split(",").map((s) => s.trim()).filter(Boolean),
      };
      if (editSlug) {
        post({ type: "action", action: "editProfile", payload: { slug: editSlug, ...payload } });
      } else {
        post({ type: "action", action: "createProfile", payload });
      }
      hideForm();
    });
    actions.appendChild(saveBtn.el);

    const cancelBtn = button("Cancel", () => hideForm());
    actions.appendChild(cancelBtn.el);
    formEl.appendChild(actions);

    el.insertBefore(formEl, list);
  }

  function hideForm(): void {
    if (formEl) {
      formEl.remove();
      formEl = null;
    }
  }

  function update(profiles: ProfileSummary[]): void {
    list.innerHTML = "";
    if (profiles.length === 0) {
      const hint = document.createElement("div");
      hint.style.color = "var(--color-dim)";
      hint.style.fontStyle = "italic";
      hint.textContent = "No profiles yet";
      list.appendChild(hint);
      return;
    }

    for (const p of profiles) {
      const row = document.createElement("div");
      row.className = "profile-row";

      const name = document.createElement("span");
      name.className = "pr-name";
      name.textContent = p.name;
      row.appendChild(name);

      const model = document.createElement("span");
      model.className = "pr-model";
      model.textContent = p.variant ? `${p.model} (${p.variant})` : p.model;
      row.appendChild(model);

      // Play button
      const play = document.createElement("button");
      play.className = "pr-play";
      play.textContent = "\u25B6";
      play.title = "Launch session from this profile";
      play.addEventListener("click", (e) => {
        e.stopPropagation();
        post({ type: "action", action: "launch", payload: { slug: p.slug } });
      });
      row.appendChild(play);

      // Overflow menu button
      const menuBtn = document.createElement("button");
      menuBtn.className = "pr-menu";
      menuBtn.textContent = "\u22EE";
      menuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        dismissMenu();
        const menu = document.createElement("div");
        menu.className = "profile-menu";

        const editItem = document.createElement("div");
        editItem.className = "profile-menu-item";
        editItem.textContent = "Edit";
        editItem.addEventListener("click", () => {
          dismissMenu();
          showForm(p.slug, p);
        });
        menu.appendChild(editItem);

        const dupItem = document.createElement("div");
        dupItem.className = "profile-menu-item";
        dupItem.textContent = "Duplicate";
        dupItem.addEventListener("click", () => {
          dismissMenu();
          post({ type: "action", action: "duplicateProfile", payload: { slug: p.slug } });
        });
        menu.appendChild(dupItem);

        const delItem = document.createElement("div");
        delItem.className = "profile-menu-item";
        delItem.textContent = "Delete";
        delItem.addEventListener("click", () => {
          dismissMenu();
          post({ type: "action", action: "deleteProfile", payload: { slug: p.slug } });
        });
        menu.appendChild(delItem);

        currentMenu = menu;
        menuBtn.appendChild(menu);
      });
      row.appendChild(menuBtn);

      list.appendChild(row);
    }
  }

  return { el, update };
}
