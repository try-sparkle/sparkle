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
