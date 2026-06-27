// apps/desktop/src/services/prd.ts
// "I'm done → PRD synthesis" service. After a Think interview wraps, this runs Chief ONCE at
// high (research) depth to synthesize a COMPLETE PRD grounded in the whole project library +
// the web, then writes it into the repo's PRD/ folder with seeded YAML frontmatter (bead
// sparkle-hiju.6). Errors propagate so the caller (UI) can surface a friendly failure.

import { invoke } from "@tauri-apps/api/core";
import type { startChat, pollForResponse } from "./chief";

/**
 * The instruction handed to Chief alongside the interview transcript. It must produce a
 * complete, concrete PRD as raw markdown — a leading `# <title>` followed by the canonical
 * sections — with every major decision grounded in (and citing) the project's existing docs.
 */
export const PRD_SKELETON_INSTRUCTION = [
  "You are synthesizing a complete Product Requirements Document (PRD) for this project.",
  "Output a COMPLETE PRD as raw markdown. Begin with a single leading title line in the form",
  '`# <title>`, then include these sections in order, each as a `## ` heading:',
  "## Problem, ## Goal, ## Users, ## Design, ## Open questions, ## Out of scope.",
  "Ground every major decision in the project's existing documents, and CITE them as inline",
  "markdown links of the form [Doc name](path). Be concrete and specific — avoid vague",
  "placeholders. Output ONLY the markdown PRD, with no preamble, commentary, or code fences.",
].join(" ");

/** Lowercase a title into a filename-safe slug: spaces/punctuation collapse to single hyphens,
 *  leading/trailing hyphens trimmed, capped at ~60 chars, and "prd" when nothing usable remains. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    // Strip combining diacritical marks left over from NFKD decomposition.
    .replace(/[̀-ͯ]/g, "")
    // Anything that isn't an ASCII alphanumeric becomes a separator.
    .replace(/[^a-z0-9]+/g, "-")
    // Collapse runs and trim the separators off both ends.
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    // A trailing hyphen can survive the length cap — trim again.
    .replace(/-+$/g, "");
  return slug || "prd";
}

/** UTC calendar date as `YYYY-MM-DD`. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Deterministic PRD filename: `<YYYY-MM-DD>-<slug>.md` (bare; the Rust command nests it in PRD/). */
export function prdFilename(title: string, d: Date): string {
  return `${isoDate(d)}-${slugify(title)}.md`;
}

/** Strip a wrapping ```/```markdown code fence and leading blank lines from a model reply. Chief is
 *  asked NOT to fence its output, but models sometimes do anyway; unwrapping keeps the leading `#`
 *  heading discoverable (and the written PRD clean). */
export function stripFences(markdown: string): string {
  let s = markdown.trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(s);
  if (fence) s = fence[1]!.trim();
  return s;
}

/** The text of the first `# ` (h1) heading in the markdown; `Untitled PRD` when there is none. */
export function extractTitle(markdown: string): string {
  for (const line of stripFences(markdown).split(/\r?\n/)) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) return m[1]!;
  }
  return "Untitled PRD";
}

export interface PrdFrontmatter {
  title: string;
  created: string;
  source: string;
  epic: string | null;
  tasks: string[];
}

/** Render a `PrdFrontmatter` as a `---`-delimited YAML block. `tasks` is a flow array `[a, b]`
 *  and `epic` is the literal `null` when absent. Strings are quoted to stay valid YAML. */
export function buildFrontmatter(fm: PrdFrontmatter): string {
  const q = (s: string) => JSON.stringify(s);
  const tasks = `[${fm.tasks.map(q).join(", ")}]`;
  const epic = fm.epic === null ? "null" : q(fm.epic);
  return [
    "---",
    `title: ${q(fm.title)}`,
    `created: ${q(fm.created)}`,
    `source: ${q(fm.source)}`,
    `epic: ${epic}`,
    `tasks: ${tasks}`,
    "---",
  ].join("\n");
}

/** Join a frontmatter block and a body with exactly one blank line between them. */
export function withFrontmatter(frontmatter: string, body: string): string {
  return `${frontmatter.replace(/\s+$/, "")}\n\n${body.replace(/^\s+/, "")}`;
}

export interface SynthesizeDeps {
  startChat: typeof startChat;
  pollForResponse: typeof pollForResponse;
  /** Wraps the Rust `write_prd` command; returns the repo-relative path written. */
  writePrd: (projectPath: string, filename: string, content: string) => Promise<string>;
  /** Clock seam for deterministic filenames/frontmatter in tests. */
  now?: () => Date;
}

export interface SynthesizeArgs {
  pat: string;
  chiefProjectId: string;
  projectPath: string;
  transcript: string;
}

export interface SynthesizeResult {
  path: string;
  filename: string;
  title: string;
  content: string;
}

/**
 * Run the one-shot PRD synthesis: ask Chief (research depth, web-enabled, scoped to the
 * project's library) to write a complete PRD from the interview transcript, then write it to
 * PRD/ with seeded frontmatter. Returns the written path plus the derived filename/title/content.
 * Errors propagate; the caller shows a friendly failure.
 */
export async function synthesizePrd(
  deps: SynthesizeDeps,
  args: SynthesizeArgs,
): Promise<SynthesizeResult> {
  const { pat, chiefProjectId, projectPath, transcript } = args;

  const { chat_id, message_id } = await deps.startChat(
    pat,
    chiefProjectId,
    `${PRD_SKELETON_INSTRUCTION}\n\nInterview transcript:\n${transcript}`,
    {
      intelligence: "research",
      publicData: true,
      scope: { project_ids: [chiefProjectId] },
    },
  );

  // Research is slow — give it a generous ceiling rather than the default ~90s.
  const raw = await deps.pollForResponse(pat, chiefProjectId, chat_id, message_id, {
    timeoutMs: 180_000,
  });

  // Unwrap a stray code fence so the title is discoverable and the written file is clean.
  const body = stripFences(raw);
  const title = extractTitle(body);
  const d = (deps.now ?? (() => new Date()))();
  const filename = prdFilename(title, d);

  const frontmatter = buildFrontmatter({
    title,
    created: d.toISOString(),
    source: "think-session",
    epic: null,
    tasks: [],
  });
  const content = withFrontmatter(frontmatter, body);

  const path = await deps.writePrd(projectPath, filename, content);
  return { path, filename, title, content };
}

/** Thin wrapper over the Rust `write_prd` command so the UI can pass it as `SynthesizeDeps.writePrd`.
 *  `filename` must be a BARE filename (no slashes); the command nests it under PRD/. */
export function writePrd(
  projectPath: string,
  filename: string,
  content: string,
): Promise<string> {
  return invoke<string>("write_prd", { projectPath, filename, content });
}
