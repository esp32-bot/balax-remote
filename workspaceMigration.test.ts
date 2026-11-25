import assert from "node:assert/strict";
import test from "node:test";
import { migrateWorkspaceV9 } from "./src/workspaceMigration.ts";

test("migrate both v9 camera IDs without changing the workspace layout", () => {
  const workspace = {
    primary: { tabs: ["fpv", "control"], activeTab: "fpv", width: 458, height: 361, collapsed: false },
    secondary: { tabs: ["flash", "camera"], activeTab: "camera", width: 601, height: 496, collapsed: true },
  };
  const migrated = migrateWorkspaceV9(JSON.stringify(workspace));
  assert.ok(migrated);
  assert.deepEqual(JSON.parse(migrated), {
    primary: { ...workspace.primary, tabs: ["camera", "control"], activeTab: "camera" },
    secondary: { ...workspace.secondary, tabs: ["flash", "view3d"], activeTab: "view3d" },
  });
});

test("ignore missing or malformed v9 records", () => {
  for (const raw of [null, "", "{", "null", '{"primary":{"tabs":[]},"secondary":{}}']) {
    assert.equal(migrateWorkspaceV9(raw), null);
  }
});
