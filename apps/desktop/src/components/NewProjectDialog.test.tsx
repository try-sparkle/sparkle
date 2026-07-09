// @vitest-environment jsdom
//
// NewProjectDialog: tab switching (folder vs GitHub), the GitHub states (signed-out / connected
// repo list / cloning / error), and that a successful clone calls addProject AND selects the new
// project. All Rust tauri commands are mocked via `invoke`.
import { type ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The tauri command bridge — every github_* command is driven per-test through this mock.
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

// Keep the sign-in handoff + native picker out of the tests (they pull tauri/browser IO).
const signInHandoff = vi.fn();
vi.mock("../services/trialUnlock", () => ({ signInHandoff: (...a: unknown[]) => signInHandoff(...a) }));
vi.mock("../services/dialog", () => ({
  pickProjectFolder: vi.fn(async () => "/Users/me/Elsewhere"),
  basename: (p: string) => p.split("/").pop() || p,
}));

import { NewProjectDialog } from "./NewProjectDialog";
import { useProjectStore } from "../stores/projectStore";

const REPO = {
  fullName: "octocat/hello",
  private: false,
  description: "A friendly hello repo",
  defaultBranch: "main",
  cloneUrl: "https://github.com/octocat/hello.git",
  pushedAt: "2026-07-01T12:00:00Z",
};
const PRIVATE_REPO = {
  ...REPO,
  fullName: "octocat/secret",
  private: true,
  description: "A private repo",
  cloneUrl: "https://github.com/octocat/secret.git",
};

/** Route each github_* command to a supplied handler; unhandled commands resolve null. */
function routeInvoke(handlers: Record<string, (args: unknown) => unknown>) {
  invoke.mockImplementation((cmd: string, args: unknown) => {
    const h = handlers[cmd];
    return Promise.resolve(h ? h(args) : null);
  });
}

const noop = () => {};

function renderDialog(over: Partial<ComponentProps<typeof NewProjectDialog>> = {}) {
  return render(
    <NewProjectDialog onClose={over.onClose ?? noop} onOpenFromFolder={over.onOpenFromFolder ?? noop} onCloned={over.onCloned ?? noop} onSignInGithub={over.onSignInGithub} />,
  );
}

afterEach(() => cleanup());
beforeEach(() => {
  invoke.mockReset();
  signInHandoff.mockReset();
});

describe("NewProjectDialog — tabs", () => {
  it("defaults to the folder tab and switches to GitHub content", async () => {
    routeInvoke({ github_status: () => ({ connected: false, login: null }) });
    renderDialog();

    // Folder tab is default.
    expect(screen.getByRole("button", { name: "Choose a folder…" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "From GitHub" }));

    // Folder content is gone; GitHub (signed-out) content is shown.
    expect(screen.queryByRole("button", { name: "Choose a folder…" })).toBeNull();
    expect(await screen.findByRole("button", { name: /Sign in with GitHub/ })).toBeTruthy();
  });

  it("folder tab runs onOpenFromFolder and closes", () => {
    routeInvoke({});
    const onOpenFromFolder = vi.fn();
    const onClose = vi.fn();
    renderDialog({ onOpenFromFolder, onClose });
    fireEvent.click(screen.getByRole("button", { name: "Choose a folder…" }));
    expect(onOpenFromFolder).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("NewProjectDialog — GitHub states", () => {
  it("signed-out shows a Sign in with GitHub button wired to the handoff", async () => {
    routeInvoke({ github_status: () => ({ connected: false, login: null }) });
    renderDialog();
    fireEvent.click(screen.getByRole("tab", { name: "From GitHub" }));

    const btn = await screen.findByRole("button", { name: /Sign in with GitHub/ });
    fireEvent.click(btn);
    expect(signInHandoff).toHaveBeenCalledOnce();
  });

  it("connected shows the repo list with a private/public badge and description", async () => {
    routeInvoke({
      github_status: () => ({ connected: true, login: "octocat" }),
      github_list_repos: () => ({ repos: [REPO, PRIVATE_REPO], hasMore: false }),
    });
    renderDialog();
    fireEvent.click(screen.getByRole("tab", { name: "From GitHub" }));

    expect(await screen.findByText("octocat/hello")).toBeTruthy();
    expect(screen.getByText("octocat/secret")).toBeTruthy();
    expect(screen.getByText("A friendly hello repo")).toBeTruthy();
    // Feather icons carry aria-labels (no emoji-as-icons).
    expect(screen.getByLabelText("Private")).toBeTruthy();
    expect(screen.getByLabelText("Public")).toBeTruthy();
  });

  it("cloning shows a progress state naming the repo", async () => {
    // A clone that never resolves keeps the dialog in the cloning state.
    routeInvoke({
      github_status: () => ({ connected: true, login: "octocat" }),
      github_list_repos: () => ({ repos: [REPO], hasMore: false }),
      github_default_project_dir: () => "/Users/me/Sparkle",
      github_clone_repo: () => new Promise(() => {}),
    });
    renderDialog();
    fireEvent.click(screen.getByRole("tab", { name: "From GitHub" }));

    fireEvent.click(await screen.findByRole("button", { name: /octocat\/hello/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Clone & Open" }));

    expect(await screen.findByText(/Cloning/)).toBeTruthy();
    expect(screen.getByText("octocat/hello")).toBeTruthy();
  });

  it("git_missing surfaces the Xcode Command Line Tools prompt", async () => {
    routeInvoke({
      github_status: () => ({ connected: true, login: "octocat" }),
      github_list_repos: () => ({ repos: [REPO], hasMore: false }),
      github_default_project_dir: () => "/Users/me/Sparkle",
      github_clone_repo: () => Promise.reject("git_missing"),
    });
    renderDialog();
    fireEvent.click(screen.getByRole("tab", { name: "From GitHub" }));
    fireEvent.click(await screen.findByRole("button", { name: /octocat\/hello/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Clone & Open" }));

    expect(await screen.findByText(/xcode-select --install/)).toBeTruthy();
  });

  it("other clone failures show the (already redacted) message inline", async () => {
    routeInvoke({
      github_status: () => ({ connected: true, login: "octocat" }),
      github_list_repos: () => ({ repos: [REPO], hasMore: false }),
      github_default_project_dir: () => "/Users/me/Sparkle",
      github_clone_repo: () => Promise.reject("destination_not_empty"),
    });
    renderDialog();
    fireEvent.click(screen.getByRole("tab", { name: "From GitHub" }));
    fireEvent.click(await screen.findByRole("button", { name: /octocat\/hello/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Clone & Open" }));

    expect(await screen.findByText("destination_not_empty")).toBeTruthy();
  });

  it("a rapid double-click on Clone & Open only clones once", async () => {
    routeInvoke({
      github_status: () => ({ connected: true, login: "octocat" }),
      github_list_repos: () => ({ repos: [REPO], hasMore: false }),
      github_default_project_dir: () => "/Users/me/Sparkle",
      github_clone_repo: () => new Promise(() => {}), // stay pending so both clicks race the guard
    });
    renderDialog();
    fireEvent.click(screen.getByRole("tab", { name: "From GitHub" }));
    fireEvent.click(await screen.findByRole("button", { name: /octocat\/hello/ }));
    const cloneBtn = await screen.findByRole("button", { name: "Clone & Open" });
    fireEvent.click(cloneBtn);
    fireEvent.click(cloneBtn);

    const cloneCalls = invoke.mock.calls.filter((c) => c[0] === "github_clone_repo");
    expect(cloneCalls).toHaveLength(1);
  });

  it("Load more appends the next page when hasMore is true", async () => {
    const first = { repos: [REPO], hasMore: true };
    const second = { repos: [PRIVATE_REPO], hasMore: false };
    routeInvoke({
      github_status: () => ({ connected: true, login: "octocat" }),
      github_list_repos: (args) => ((args as { page: number }).page >= 2 ? second : first),
    });
    renderDialog();
    fireEvent.click(screen.getByRole("tab", { name: "From GitHub" }));

    expect(await screen.findByText("octocat/hello")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("octocat/secret")).toBeTruthy();
    // First page stays (appended, not replaced).
    expect(screen.getByText("octocat/hello")).toBeTruthy();
  });
});

describe("NewProjectDialog — clone success wires addProject + selection", () => {
  it("a successful clone calls onCloned; wiring it to addProject selects the new project", async () => {
    const CLONED_PATH = "/Users/me/Sparkle/hello";
    routeInvoke({
      github_status: () => ({ connected: true, login: "octocat" }),
      github_list_repos: () => ({ repos: [REPO], hasMore: false }),
      github_default_project_dir: () => "/Users/me/Sparkle",
      github_clone_repo: () => CLONED_PATH,
    });

    // Drive the real project store the way TopBar does (addProject creates + selects).
    useProjectStore.setState({ projects: [], selectedProjectId: null });
    const addProject = useProjectStore.getState().addProject;
    const onCloned = vi.fn((name: string, path: string) => addProject(name, path));
    const onClose = vi.fn();

    renderDialog({ onCloned, onClose });
    fireEvent.click(screen.getByRole("tab", { name: "From GitHub" }));
    fireEvent.click(await screen.findByRole("button", { name: /octocat\/hello/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Clone & Open" }));

    await waitFor(() => expect(onCloned).toHaveBeenCalledWith("hello", CLONED_PATH));
    expect(invoke).toHaveBeenCalledWith("github_clone_repo", expect.objectContaining({ cloneUrl: REPO.cloneUrl }));
    expect(onClose).toHaveBeenCalled();

    // The new project exists AND is selected.
    const st = useProjectStore.getState();
    const created = st.projects.find((p) => p.rootPath === CLONED_PATH);
    expect(created).toBeTruthy();
    expect(st.selectedProjectId).toBe(created!.id);
  });
});
