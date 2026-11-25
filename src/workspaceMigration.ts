/** Translates the saved v9 tab IDs before the shared workspace loader validates them. */
export function migrateWorkspaceV9(raw: string | null): string | null {
  if (!raw) return null;
  const renameTab = (id: unknown) => id === "fpv" ? "camera" : id === "camera" ? "view3d" : id;
  try {
    const workspace = JSON.parse(raw);
    if (!workspace?.primary || !workspace.secondary) return null;
    for (const slot of [workspace.primary, workspace.secondary]) {
      if (!Array.isArray(slot.tabs)) return null;
      slot.tabs = slot.tabs.map(renameTab);
      slot.activeTab = renameTab(slot.activeTab);
    }
    return JSON.stringify(workspace);
  } catch {
    return null;
  }
}
