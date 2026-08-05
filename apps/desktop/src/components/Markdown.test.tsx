// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown";

// External links route through the Tauri opener rather than navigating the webview.
const openUrl = vi.fn((_url: string) => Promise.resolve());
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (url: string) => openUrl(url) }));

afterEach(() => {
  cleanup();
  openUrl.mockClear();
});

describe("Markdown", () => {
  it("renders bold text", () => {
    render(<Markdown text="hello **world**" />);
    const strong = screen.getByText("world");
    expect(strong.tagName).toBe("STRONG");
  });

  it("renders an external link with href + target and opens it via the opener", () => {
    render(<Markdown text="see [Sparkle](https://sparkle.ai/docs)" />);
    const link = screen.getByRole("link", { name: "Sparkle" });
    expect(link.getAttribute("href")).toBe("https://sparkle.ai/docs");
    expect(link.getAttribute("target")).toBe("_blank");
    fireEvent.click(link);
    expect(openUrl).toHaveBeenCalledWith("https://sparkle.ai/docs");
  });

  it("opens a mailto: link via the opener", () => {
    render(<Markdown text="mail [us](mailto:hi@sparkle.ai)" />);
    fireEvent.click(screen.getByRole("link", { name: "us" }));
    expect(openUrl).toHaveBeenCalledWith("mailto:hi@sparkle.ai");
  });

  // Security (sparkle-g0su): react-markdown strips javascript: but NOT file:/vscode:/other custom
  // OS URI handlers. An attacker-influenced link must NEVER reach the native opener, and the anchor
  // must be inert (no href for the webview to navigate to).
  it.each([
    ["vscode", "[open](vscode://file/etc/passwd)"],
    ["file", "[open](file:///etc/passwd)"],
    ["smb", "[open](smb://attacker/share)"],
  ])("does NOT open a disallowed %s: href and renders it inert", (_scheme, text) => {
    render(<Markdown text={text} />);
    // An inert anchor has no href, so it loses the implicit "link" role — query by its text.
    const link = screen.getByText("open");
    expect(link.tagName).toBe("A");
    // No href → the webview can't navigate to the custom scheme.
    expect(link.getAttribute("href")).toBeNull();
    fireEvent.click(link);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("does not open a javascript: href (defense in depth)", () => {
    render(<Markdown text="[x](javascript:alert(1))" />);
    const link = screen.getByText("x");
    expect(link.getAttribute("href")).toBeNull();
    fireEvent.click(link);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("renders a remote http image as inert alt text (no outbound request)", () => {
    render(<Markdown text="![a cat](http://tracker.example/beacon.png)" />);
    // Blocked src → no <img> is emitted; the alt text stands in.
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("a cat")).toBeTruthy();
  });

  it("renders an https image normally", () => {
    render(<Markdown text="![ok](https://sparkle.ai/logo.png)" />);
    const img = document.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://sparkle.ai/logo.png");
  });

  it("renders a fenced code block as <pre>/<code>", () => {
    render(<Markdown text={"```js\nconst x = 1;\n```"} />);
    const code = screen.getByText(/const x = 1;/);
    expect(code.tagName).toBe("CODE");
    expect(code.closest("pre")).not.toBeNull();
  });

  it("renders inline code", () => {
    render(<Markdown text="use the `npm` tool" />);
    const code = screen.getByText("npm");
    expect(code.tagName).toBe("CODE");
    expect(code.closest("pre")).toBeNull();
  });

  it("renders a GFM table", () => {
    render(
      <Markdown
        text={["| Name | Role |", "| --- | --- |", "| Ada | Eng |"].join("\n")}
      />,
    );
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Ada" })).toBeTruthy();
  });
});

// ── QUOTE BARS (sparkle-3hd6b) ──────────────────────────────────────────────────────────────────
//
// The founder's screenshot of a five-line quote showed FIVE SHORT GRAY DASHES down the left edge
// rather than one rule. `Markdown.tsx` has always drawn `borderLeft: 3px solid` on the blockquote,
// so the defect was never the style — the QUOTE was five separate blockquotes.
//
// The concierge quotes his messages back on a standing communication guideline, and it writes that
// markdown with a BLANK LINE between quoted lines. Under CommonMark a blank line ENDS a blockquote,
// so `> a\n\n> b` is two `blockquote` nodes, each with its own 3px border and the 8px bottom margin
// between them. Five lines, five dashes — exactly the screenshot. Verified directly against this
// repo's own parser before the fix: blank-separated → 5 blockquotes, contiguous `> a\n> b` → 1.
//
// These assert the RENDERED OUTCOME (how many bars, what colour), not the plugin's internals, so
// they would still hold if the merge were achieved some other way.
describe("Markdown blockquotes", () => {
  const FIVE_LINES = ["one", "two", "three", "four", "five"];
  const blankSeparated = FIVE_LINES.map((l) => `> ${l}`).join("\n\n");

  function quotes(container: HTMLElement): HTMLQuoteElement[] {
    return Array.from(container.querySelectorAll("blockquote"));
  }

  it("renders blank-line-separated quoted lines as ONE bar, not one per line", () => {
    const { container } = render(<Markdown text={blankSeparated} mergeQuotes />);
    expect(quotes(container)).toHaveLength(1);
  });

  it("leaves the block structure ALONE without the opt-in", () => {
    // The merge is a judgement about the AUTHOR, not a fact about the markup: `> a\n\n> b` is also
    // how a writer spells two deliberately separate quotations. This renderer is shared with raw
    // agent output (MountedAgentThread) and authored help (SupportModal), where folding two
    // excerpts into one quotation would misrepresent them — so those surfaces keep every quote.
    const { container } = render(<Markdown text={blankSeparated} />);
    expect(quotes(container)).toHaveLength(5);
  });

  it("keeps every quoted line, in order, inside that one bar", () => {
    // The merge must not swallow content or run the lines together — it moves whole blocks, so each
    // line stays its own paragraph.
    const { container } = render(<Markdown text={blankSeparated} mergeQuotes />);
    const bq = quotes(container)[0]!;
    expect(Array.from(bq.querySelectorAll("p")).map((p) => p.textContent)).toEqual(FIVE_LINES);
  });

  it("merges a quote split inside a LIST ITEM — the walk really does recurse", () => {
    // The plugin advertises "runs at any depth", and every other fixture here is a flat top-level
    // tree, so nothing would fail if the recursion were dropped. A quotation inside a list item
    // splits on a blank line exactly as a top-level one does.
    const { container } = render(
      <Markdown text={"- item\n\n  > one\n\n  > two\n"} mergeQuotes />,
    );
    expect(quotes(container)).toHaveLength(1);
    expect(Array.from(quotes(container)[0]!.querySelectorAll("p")).map((p) => p.textContent)).toEqual(
      ["one", "two"],
    );
  });

  it("merges a NESTED pair, and the merge happens in its final home", () => {
    // Pins the walk-after-merge ordering: the outer quotes fold first, and the inner pair is then
    // walked once inside the surviving parent. Swapping the loops or dropping the recursion leaves
    // two inner bars.
    const { container } = render(<Markdown text={"> > a\n\n> > b\n"} mergeQuotes />);
    expect(quotes(container)).toHaveLength(2); // one outer, one inner — not three
    const inner = quotes(container)[1]!;
    expect(Array.from(inner.querySelectorAll("p")).map((p) => p.textContent)).toEqual(["a", "b"]);
  });

  it("draws the bar in the ACCENT token, never the gray hairline", () => {
    // `C.tealInk` is `var(--c-teal-ink)` — the SAME token LogoWaveform paints "Hold ⌘ to talk" in,
    // which is the line the founder pointed at ("the same blue"). Asserted through the style
    // ATTRIBUTE that React writes, because jsdom's shorthand parser drops a `var()` border and
    // `.style.borderLeftColor` would read empty — a vacuous pass. See docs/jsdom-test-caveats.md.
    const { container } = render(<Markdown text={blankSeparated} mergeQuotes />);
    const style = quotes(container)[0]!.getAttribute("style") ?? "";
    expect(style).toContain("var(--c-teal-ink)");
    // The gray it replaced must be gone, or the bar is still chrome-coloured.
    expect(style).not.toContain("138, 160, 196");
  });

  it("still merges a CONTIGUOUS quote into one bar", () => {
    const { container } = render(
      <Markdown text={FIVE_LINES.map((l) => `> ${l}`).join("\n")} mergeQuotes />,
    );
    expect(quotes(container)).toHaveLength(1);
  });

  it("does NOT merge quotes the author separated with real content", () => {
    // Whitespace-adjacent siblings merge; anything with a block between them is two deliberate
    // quotes and must stay two. Without this the plugin would silently rewrite the author's meaning.
    const { container } = render(
      <Markdown text={"> first quote\n\nan interrupting paragraph\n\n> second quote"} mergeQuotes />,
    );
    expect(quotes(container)).toHaveLength(2);
  });

  it("leaves a quote that follows a list alone", () => {
    // Guards the walk against merging across a non-quote sibling of a different shape.
    const { container } = render(
      <Markdown text={"> quoted\n\n- a list item\n\n> also quoted"} mergeQuotes />,
    );
    expect(quotes(container)).toHaveLength(2);
  });
});
