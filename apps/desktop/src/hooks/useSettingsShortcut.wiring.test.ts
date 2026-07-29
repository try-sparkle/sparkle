// Is the ⌘, binding actually MOUNTED?
//
// useSettingsShortcut.test.tsx proves the hook opens Settings from every focus context — but it
// renders the hook itself, so it would stay green for a hook that production never calls. A hook
// nobody mounts is exactly as broken as the missing shortcut this fixed, and that gap is how the
// bug class keeps shipping here (see ConciergeHost.needsYouPill.test.ts for the same shape: a
// control certified by tests and unreachable by users).
//
// Asserted against the SOURCE, deliberately. Rendering <App/> to look for the binding would need
// the whole authenticated shell stood up first — xterm, Tauri `invoke`, the lazy Workspace chunk —
// and a test that heavy is one nobody keeps working. Reading the file cannot be fooled by mocks.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

describe("the ⌘, shortcut is mounted in production", () => {
  it("App.tsx imports the hook", () => {
    expect(app).toMatch(/import \{ useSettingsShortcut \} from ".\/hooks\/useSettingsShortcut"/);
  });

  it("…and CALLS it — an unused import would satisfy the check above and bind nothing", () => {
    // Anchored to the start of a line so a mention inside a comment cannot pass for the call.
    expect(app).toMatch(/^\s*useSettingsShortcut\(\);/m);
  });
});
