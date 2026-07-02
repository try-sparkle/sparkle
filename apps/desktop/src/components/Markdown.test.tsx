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
    // eslint-disable-next-line no-script-url
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
