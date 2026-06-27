import { describe, it, expect, vi } from "vitest";
import {
  slugify,
  isoDate,
  prdFilename,
  extractTitle,
  buildFrontmatter,
  withFrontmatter,
  synthesizePrd,
  type SynthesizeDeps,
} from "./prd";

describe("slugify", () => {
  it("lowercases and hyphenates spaces + punctuation", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
    expect(slugify("Think → Build loop")).toBe("think-build-loop");
  });
  it("collapses runs and trims edge hyphens", () => {
    expect(slugify("  --Foo   Bar-- ")).toBe("foo-bar");
  });
  it("strips diacritics", () => {
    expect(slugify("Café Déjà")).toBe("cafe-deja");
  });
  it("falls back to 'prd' when nothing usable remains", () => {
    expect(slugify("")).toBe("prd");
    expect(slugify("???")).toBe("prd");
  });
  it("caps length and trims a trailing hyphen left by the cap", () => {
    const slug = slugify("a".repeat(80));
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("isoDate / prdFilename", () => {
  it("formats UTC date as YYYY-MM-DD", () => {
    expect(isoDate(new Date("2026-06-27T18:30:00Z"))).toBe("2026-06-27");
  });
  it("composes <date>-<slug>.md", () => {
    expect(prdFilename("Offline Mode", new Date("2026-06-27T00:00:00Z"))).toBe(
      "2026-06-27-offline-mode.md",
    );
  });
});

describe("extractTitle", () => {
  it("returns the first h1 text", () => {
    expect(extractTitle("# My PRD\n\n## Problem\n...")).toBe("My PRD");
  });
  it("picks the first when several headings exist", () => {
    expect(extractTitle("# First\n# Second")).toBe("First");
  });
  it("falls back when there is no h1", () => {
    expect(extractTitle("## Problem only")).toBe("Untitled PRD");
  });
  it("finds the title even when the model wraps the reply in a code fence", () => {
    expect(extractTitle("```markdown\n# Fenced PRD\n\n## Problem\n```")).toBe("Fenced PRD");
  });
});

describe("buildFrontmatter / withFrontmatter", () => {
  it("renders null epic and empty tasks", () => {
    const fm = buildFrontmatter({
      title: "T",
      created: "2026-06-27T00:00:00.000Z",
      source: "think-session",
      epic: null,
      tasks: [],
    });
    expect(fm).toContain("epic: null");
    expect(fm).toContain("tasks: []");
    expect(fm.startsWith("---\n")).toBe(true);
    expect(fm.endsWith("\n---")).toBe(true);
  });
  it("renders epic id and a flow array of tasks", () => {
    const fm = buildFrontmatter({
      title: "T",
      created: "x",
      source: "s",
      epic: "",
      tasks: [".1", ".2"],
    });
    expect(fm).toContain('epic: ""');
    expect(fm).toContain('tasks: [".1", ".2"]');
  });
  it("joins frontmatter + body with exactly one blank line", () => {
    expect(withFrontmatter("---\na: 1\n---", "# Body")).toBe("---\na: 1\n---\n\n# Body");
  });
});

describe("synthesizePrd", () => {
  function makeDeps(over: Partial<SynthesizeDeps> = {}) {
    const startChat = vi.fn().mockResolvedValue({ chat_id: "c", message_id: "m" });
    const pollForResponse = vi.fn().mockResolvedValue("# Offline Mode\n\n## Problem\nNeed it.");
    const writePrd = vi.fn().mockResolvedValue("PRD/2026-06-27-offline-mode.md");
    const deps: SynthesizeDeps = {
      startChat: startChat as unknown as SynthesizeDeps["startChat"],
      pollForResponse: pollForResponse as unknown as SynthesizeDeps["pollForResponse"],
      writePrd,
      now: () => new Date("2026-06-27T00:00:00Z"),
      ...over,
    };
    return { deps, startChat, pollForResponse, writePrd };
  }

  it("runs Chief at research depth with web enabled and writes the derived file", async () => {
    const { deps, startChat, writePrd } = makeDeps();
    const result = await synthesizePrd(deps, {
      pat: "pat",
      chiefProjectId: "proj",
      projectPath: "/repo",
      transcript: "we want offline mode",
    });

    expect(startChat).toHaveBeenCalledWith(
      "pat",
      "proj",
      expect.stringContaining("we want offline mode"),
      expect.objectContaining({ intelligence: "research", publicData: true }),
    );
    expect(result.title).toBe("Offline Mode");
    expect(result.filename).toBe("2026-06-27-offline-mode.md");
    // write_prd receives the frontmatter + body.
    const [, fname, content] = writePrd.mock.calls[0]!;
    expect(fname).toBe("2026-06-27-offline-mode.md");
    expect(content).toContain("source: \"think-session\"");
    expect(content).toContain("# Offline Mode");
    expect(result.path).toBe("PRD/2026-06-27-offline-mode.md");
  });

  it("propagates a synthesis failure (does not swallow)", async () => {
    const { deps } = makeDeps({
      pollForResponse: vi.fn().mockRejectedValue(new Error("Chief timed out")) as never,
    });
    await expect(
      synthesizePrd(deps, { pat: "p", chiefProjectId: "c", projectPath: "/r", transcript: "x" }),
    ).rejects.toThrow("Chief timed out");
  });
});
