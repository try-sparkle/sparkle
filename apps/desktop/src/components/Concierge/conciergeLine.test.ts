import { describe, expect, it } from "vitest";
import { flat, hasAgentRef, line, plain, ref } from "./conciergeLine";
import { parseAgentRefHref, stripAgentRefs, stripMentionSigil } from "./agentRefs";
import { fromMarkdown } from "mdast-util-from-markdown";

const KRAKEN = { id: "9f3c-aaaa-1111", name: "Kraken Auth" };

/** Every link node the renderer would see, read through the SAME grammar it renders with.
 *
 *  Asserting on the parse rather than on the source string is the difference between "the text does
 *  not contain these characters" and "the renderer will not draw a pill" — only the second is the
 *  property under test, and the two disagree exactly where escaping is involved. */
function linksIn(md: string): { url: string; label: string }[] {
  const links: { url: string; label: string }[] = [];
  const walk = (n: { type: string; url?: string; children?: unknown[]; value?: string }): void => {
    if (n.type === "link") {
      const label = (n.children ?? []).map((c) => (c as { value?: string }).value ?? "").join("");
      links.push({ url: n.url ?? "", label });
    }
    for (const c of n.children ?? []) walk(c as never);
  };
  walk(fromMarkdown(md) as never);
  return links;
}

function soleLink(md: string): { url: string; label: string } {
  const links = linksIn(md);
  expect(links).toHaveLength(1);
  const only = links[0];
  if (!only) throw new Error("unreachable: length asserted above");
  return only;
}

describe("ref() — an agent's name always carries its id", () => {
  it("emits a link the renderer will turn into a pill", () => {
    const l = line`${ref(KRAKEN)} is up — I sent your message.`;
    const link = soleLink(l.md);
    // The id survives the round trip through the parser the renderer actually uses.
    expect(parseAgentRefHref(link.url)).toBe(KRAKEN.id);
    expect(stripMentionSigil(link.label)).toBe("Kraken Auth");
  });

  it("speaks the plain sentence, with no markdown and no id", () => {
    const l = line`${ref(KRAKEN)} is up — I sent your message.`;
    // This is the string the live region gets. A uuid read aloud is unskippable.
    expect(l.spoken).toBe("Kraken Auth is up — I sent your message.");
    expect(l.spoken).not.toContain("sparkle-agent:");
    expect(l.spoken).not.toContain("[");
  });

  it("copies to the clipboard as words, because stripAgentRefs understands what it wrote", () => {
    // The reference-writing side and the reference-flattening side must agree; if `ref` emitted a
    // shape `stripAgentRefs` could not parse, a paste would carry an internal uuid.
    const l = line`${ref(KRAKEN)} is up.`;
    expect(stripAgentRefs(l.md)).toBe("@Kraken Auth is up.");
  });
});

describe("ref() — degrading without lying", () => {
  it("falls back to plain text when the id is not one the parser would accept", () => {
    // A malformed id must not be written at all: the renderer would refuse it, and the clipboard
    // would keep a dead link with an internal value in it.
    const l = line`${ref({ id: "not a valid id", name: "Kraken Auth" })} is up.`;
    expect(l.md).toBe("Kraken Auth is up.");
    expect(hasAgentRef(l.md)).toBe(false);
  });

  it("falls back to 'that agent' rather than rendering a bare @", () => {
    const l = line`${ref({ id: KRAKEN.id, name: "  " })} is up.`;
    expect(l.md).toBe("that agent is up.");
    expect(l.spoken).toBe("that agent is up.");
  });

  it("escapes a name that would otherwise break out of the link label", () => {
    const l = line`${ref({ id: KRAKEN.id, name: "Build [5] *beta*" })} is up.`;
    const link = soleLink(l.md);
    // The whole name is inside the label, and the href is untouched by it.
    expect(stripMentionSigil(link.label)).toBe("Build [5] *beta*");
    expect(parseAgentRefHref(link.url)).toBe(KRAKEN.id);
  });
});

describe("plain() — text that is deliberately not an agent", () => {
  it("passes words through to both renderings", () => {
    const l = line`${ref(KRAKEN)} is up — I sent your message${plain(' ("ship it")')}.`;
    expect(l.spoken).toBe('Kraken Auth is up — I sent your message ("ship it").');
    expect(soleLink(l.md).url).toBe(`sparkle-agent:${KRAKEN.id}`);
  });

  it("escapes link syntax in interpolated text so a quoted payload cannot forge a reference", () => {
    // The quoted payload is arbitrary user prose. Without escaping, a user who types
    // "[@Someone](sparkle-agent:victim)" into a relayed message would get a REAL pill pointing at
    // an agent the app never named — a link carrying an id the reader has no reason to trust.
    const hostile = plain("[@Payments](sparkle-agent:agent-victim)");
    const l = line`I sent ${hostile}.`;
    // The words survive verbatim — nothing is censored, the reader sees what was sent…
    expect(l.spoken).toBe("I sent [@Payments](sparkle-agent:agent-victim).");
    // …but the renderer sees NO link at all, so it cannot draw a pill carrying an id the app never
    // vouched for. A pill with the wrong id opens the wrong agent and the reader cannot tell.
    expect(linksIn(l.md)).toEqual([]);
  });

  it("blocks the AUTOLINK form too, which needs no brackets at all", () => {
    // CommonMark `<scheme:rest>` makes a real link node with no `[](…)` anywhere, and `sparkle-agent`
    // is a valid scheme. Because `AgentPill` prefers the LIVE ROSTER NAME over the label, this
    // rendered as an ordinary pill naming an agent the app never vouched for — reachable from a
    // picker option or a relayed quote (roborev 56060). The bracket case above passed throughout.
    const l = line`I sent ${plain("<sparkle-agent:agent-victim>")}.`;
    expect(l.spoken).toBe("I sent <sparkle-agent:agent-victim>.");
    expect(linksIn(l.md)).toEqual([]);
  });

  it("does not let a hostile payload forge a reference even alongside a real one", () => {
    const l = line`${ref(KRAKEN)} got ${plain("[@Payments](sparkle-agent:agent-victim)")}.`;
    // Exactly one link, and it is the one the APP wrote.
    expect(linksIn(l.md)).toEqual([
      { url: `sparkle-agent:${KRAKEN.id}`, label: "@Kraken Auth" },
    ]);
  });
});

describe("flat() — a line that names nobody", () => {
  it("is the same words in both renderings", () => {
    expect(flat("Working on it…")).toEqual({ md: "Working on it…", spoken: "Working on it…" });
  });
});

// ── THE TYPE-LEVEL GATE ─────────────────────────────────────────────────────────────────────────
// These are assertions for `tsc`, NOT for vitest, and the distinction is why they are never called.
//
// `@ts-expect-error` fails the TYPECHECK if the line below it compiles cleanly — that is the whole
// assertion, and the project's typecheck runs it in CI. vitest, which erases types, would simply
// execute the bad call and crash on the malformed slot, testing nothing about the gate. So the
// bodies live in functions that exist to be compiled and never to run.
const _typeGate = {
  bareStringIsRejected: () => {
    // `${a.name}` is the exact bug this module exists to prevent: it must not COMPILE.
    // @ts-expect-error a bare string is not a Slot — use ref(agent) or plain(text)
    return line`${KRAKEN.name} is up.`;
  },
  agentObjectIsRejected: () => {
    // @ts-expect-error an agent is not a Slot either — it must go through ref()
    return line`${KRAKEN} is up.`;
  },
  refAndPlainAreAccepted: () => line`${ref(KRAKEN)} is up${plain(" now")}.`,
};

describe("the type-level gate", () => {
  it("is enforced by the typecheck, not at runtime", () => {
    // Guards the guard: if someone deletes the @ts-expect-error lines to quiet a build, this fails
    // and says why, rather than the gate silently disappearing.
    expect(Object.keys(_typeGate)).toEqual([
      "bareStringIsRejected",
      "agentObjectIsRejected",
      "refAndPlainAreAccepted",
    ]);
  });
});
