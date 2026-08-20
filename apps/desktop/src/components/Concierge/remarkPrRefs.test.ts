import { fromMarkdown } from "mdast-util-from-markdown";
import { describe, expect, it } from "vitest";

import { remarkPrRefs } from "./remarkPrRefs";
import { type MdastWalkNode } from "./mdastTextWalk";

/** Every `sparkle-pr:` link the plugin produced, as `[visible text, href]`. */
function prLinks(md: string): [string, string][] {
  const tree = fromMarkdown(md) as MdastWalkNode;
  remarkPrRefs()(tree);
  const out: [string, string][] = [];
  const visit = (n: MdastWalkNode): void => {
    if (n.type === "link" && typeof n.url === "string" && n.url.startsWith("sparkle-pr:")) {
      out.push([text(n), n.url]);
    }
    for (const c of n.children ?? []) visit(c);
  };
  visit(tree);
  return out;
}

function text(n: MdastWalkNode): string {
  if (typeof n.value === "string") return n.value;
  return (n.children ?? []).map(text).join("");
}

describe("remarkPrRefs", () => {
  it("turns a bare PR number into a reference the renderer can pill", () => {
    expect(prLinks("Merged #2164 into main.")).toEqual([["#2164", "sparkle-pr:2164"]]);
  });

  it("writes an UNQUALIFIED reference — parse time cannot know the repo", () => {
    const links = prLinks("blocked behind #2100");
    expect(links).toHaveLength(1);
    expect(links[0]?.[1]).toBe("sparkle-pr:2100");
    expect(links[0]?.[1]).not.toContain("/");
  });

  it("leaves the surrounding prose exactly where it was", () => {
    const tree = fromMarkdown("blocked behind #2100 for now") as MdastWalkNode;
    remarkPrRefs()(tree);
    const para = tree.children?.[0];
    expect((para?.children ?? []).map((c) => c.type)).toEqual(["text", "link", "text"]);
    expect(para?.children?.[0]?.value).toBe("blocked behind ");
    expect(para?.children?.[2]?.value).toBe(" for now");
  });

  it("finds several in one paragraph", () => {
    expect(prLinks("#12 landed, #2164 did not").map(([t]) => t)).toEqual(["#12", "#2164"]);
  });

  // ── THE THREE THINGS A STRING PASS WOULD GET WRONG ────────────────────────────────────────────
  // Each of these is a node the shared walk never offers. They are asserted here rather than in
  // mdastTextWalk's own tests because THIS is the plugin whose output a reader would see.

  it("NEVER rewrites inside an inline code span — that is a command someone is about to copy", () => {
    expect(prLinks("run `gh pr view #2164` verbatim")).toEqual([]);
  });

  it("NEVER rewrites inside a fenced block", () => {
    expect(prLinks("```\ngh pr merge #2164 --merge\n```")).toEqual([]);
  });

  it("NEVER nests a reference inside an existing link", () => {
    expect(prLinks("[the #2164 work](https://example.com)")).toEqual([]);
  });

  it("…including when the link's text is nested one level down in emphasis", () => {
    expect(prLinks("[**#2164**](https://example.com)")).toEqual([]);
  });

  it("does not touch a paragraph with nothing to linkify", () => {
    const tree = fromMarkdown("step #3 of the plan") as MdastWalkNode;
    const before = tree.children?.[0]?.children?.[0];
    remarkPrRefs()(tree);
    // The SAME node object, so its `position` — which `stripPrRefs` splices by — is untouched.
    expect(tree.children?.[0]?.children?.[0]).toBe(before);
  });

  it("creates nodes with NO position, so a splicing consumer leaves them literal", () => {
    const tree = fromMarkdown("Merged #2164.") as MdastWalkNode;
    remarkPrRefs()(tree);
    const link = tree.children?.[0]?.children?.[1];
    expect(link?.type).toBe("link");
    expect(link?.position).toBeUndefined();
  });
});
