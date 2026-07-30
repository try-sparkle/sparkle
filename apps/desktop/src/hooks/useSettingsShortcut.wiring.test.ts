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

  // WHERE it mounts is load-bearing, not cosmetic (roborev 55310, then 55487). The hook only
  // *requests* a category, and NOTHING clears a request nobody consumed; the sole consumer derives
  // `settingsVisible = settingsOpen || settingsRequest !== null` on its first render. So wherever
  // the binding is live without that consumer mounted, a press does nothing AND latches, and the
  // dialog springs open uninvited the moment the consumer appears.
  //
  // There are TWO boundaries between them, which is why this assertion moved: AuthGate (withholds
  // everything until entitled/trial) and the <Suspense> around the React.lazy Workspace (the chunk
  // fetch right after sign-in). Pinning against AuthGate — as this test first did — left the second
  // window open with the identical symptom. <Suspense> is inside AuthGate, so pinning the inner
  // boundary implies the outer one; assert the one that actually gates the consumer.
  it("mounts <SettingsShortcut/> INSIDE the <Suspense> that gates Workspace", () => {
    const openSuspense = app.indexOf("<Suspense fallback={null}>");
    const closeSuspense = app.indexOf("</Suspense>", openSuspense);
    const mount = app.indexOf("<SettingsShortcut />");
    expect(openSuspense).toBeGreaterThan(-1);
    expect(closeSuspense).toBeGreaterThan(openSuspense);
    expect(mount).toBeGreaterThan(openSuspense);
    expect(mount).toBeLessThan(closeSuspense);
  });

  it("…and that <Suspense> is itself inside <AuthGate>, so the outer gate still holds", () => {
    const openGate = app.indexOf("<AuthGate>");
    const closeGate = app.indexOf("</AuthGate>");
    const mount = app.indexOf("<SettingsShortcut />");
    expect(openGate).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(openGate);
    expect(mount).toBeLessThan(closeGate);
  });

  it("does NOT call the hook from App()'s own body — that is above both boundaries", () => {
    // The only call must be inside the SettingsShortcut component. If App() calls it directly the
    // binding is live on the sign-in screen again, which is the exact regression above.
    const component = app.slice(
      app.indexOf("function SettingsShortcut()"),
      app.indexOf("function SettingsShortcut()") + 200,
    );
    expect(component).toMatch(/useSettingsShortcut\(\);/);
    // Exactly one call site in the whole file.
    expect(app.match(/^\s*useSettingsShortcut\(\);/gm)).toHaveLength(1);
  });
});
