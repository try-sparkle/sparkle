// @vitest-environment jsdom
//
// BORROW/RESTORE MUST SURVIVE A SHORTHAND HOLDING A `var()` — bead `sparkle-8qd0ey`.
//
// ══ WHAT IS BEING GUARDED ══════════════════════════════════════════════════════════════════════
// A themed node is painted with a SHORTHAND carrying a `var()` (`background: var(--c-epic-card-
// fill)`). Such a shorthand gives each of its longhands a *pending-substitution* value, and a
// longhand read of one serializes as the EMPTY STRING. So a borrow that snapshots the longhand
// captures `""`, and the restore writes `""` back — the node's declaration is destroyed by a round
// trip whose capture and restore look perfectly symmetric. It shipped as a permanent full-width
// gray bar (`sparkle-huw924.15`), because React does not re-write a style prop whose value has not
// changed.
//
// ══ WHY THESE ASSERTIONS READ THE INLINE DECLARATION AND NOT A COMPUTED VALUE ══════════════════
// jsdom never loads the stylesheet and never lays out, so `getComputedStyle(el).backgroundColor`
// resolves no `var()`, has no UA `ButtonFace` to fall back to, and would make every assertion here
// inert (`docs/jsdom-test-caveats.md`). So every assertion below is on the INLINE DECLARATION TEXT:
// what was set, and what reads back.
//
// ══ EXACTLY HOW MUCH OF THE BUG THIS ENVIRONMENT CAN EXPRESS — MEASURED, NOT ASSUMED ═══════════
// The defect has TWO halves, and jsdom reproduces the first and not the second. Saying which is
// which is the difference between a guard and a green file that proves nothing:
//
//   1. THE LOSSY CAPTURE — reproduced here, and it is the half this helper exists to fix. A
//      shorthand carrying a `var()` gives its longhands pending-substitution values, so a longhand
//      read serializes as `""`. jsdom's CSSOM does this faithfully. `a shorthand holding a var()…`
//      and `the naive longhand snapshot…` below MEASURE it rather than assuming it, so this file
//      cannot go green merely because the environment is unable to express the bug.
//   2. THE DESTRUCTIVE RESTORE — NOT reproduced here. In a real engine, writing a rival longhand
//      over a `var()` shorthand and then clearing it takes the shorthand's colour with it. jsdom
//      keeps the two declarations independent, so the naive round trip happens to come out clean
//      here even though it destroys the node in WebKit and Chromium. NOTHING in this file asserts
//      that half, and nothing in it could. It was measured in playwright against both engines, and
//      the guarantee that `EpicsColumn`'s flash leaves the right declaration behind lives in
//      `EpicsColumn.revealFlash.test.tsx`, which drives the real component.
//
// That boundary is why the round-trip tests below are written against `cssText` rather than against
// a painted colour: half 1 is enough to make the SNAPSHOT lossy, and a snapshot that captured
// nothing restores nothing regardless of which engine then paints the hole.
//
// The engine-specific colour a real browser paints over an emptied declaration (WebKit `#c0c0c0`,
// Chromium `#efefef`) is deliberately NOT asserted anywhere: pinning an engine default would pin
// the defect's symptom instead of its cause.
//
// ══ AND THE SECOND DEFECT, WHICH THE FIRST FIX CREATES IF IT IS UNCONDITIONAL ══════════════════
// Re-declaring the snapshot wholesale trades this bug for its mirror image. React writes inline
// styles by DIFFING `lastProps.style` against `nextProps.style`, so reverting a write it has
// already made desyncs its bookkeeping from the DOM — and the next render diffs against that same
// bookkeeping, so React never writes the value again and the node is stuck for good. The
// `when somebody else writes to the node during the borrowed window` block at the bottom of this
// file guards that direction; unlike half 2 of the first defect, jsdom models it perfectly, because
// it is ordinary CSSOM writes racing and not an engine's shorthand bookkeeping.
import { describe, expect, it } from "vitest";

import { borrowInlineStyle } from "./borrowInlineStyle";

/** The exact declaration `EpicRow` emits, and the shape of every themed node in this app. */
const THEMED_SHORTHAND = "background: var(--c-epic-card-fill)";
/** What a transient effect paints over it. A literal, so nothing here depends on the theme. */
const FLASH_FILL = "#e0982f";
/** ...and what the CSSOM stores it as. A colour is normalized to its `rgb()` form on the way IN —
 *  ordinary CSSOM serialization, not a jsdom quirk — so a during-the-borrow read gives this, never
 *  the hex that was written. Asserting the hex would fail for a reason that has nothing to do with
 *  borrowing. Note the contrast with `var(--c-epic-card-fill)`, which is NOT a colour to the parser
 *  and so survives verbatim: that asymmetry is the whole reason a `var()` shorthand is special. */
const FLASH_FILL_SERIALIZED = "rgb(224, 152, 47)";

function node(style?: string): HTMLElement {
  const el = document.createElement("button");
  if (style !== undefined) el.setAttribute("style", style);
  return el;
}

describe("borrowInlineStyle", () => {
  // ── THE PRECONDITION, MEASURED ───────────────────────────────────────────────────────────────
  // Without this, the rest of the file could be green because the environment cannot express the
  // bug rather than because the code is right. It asserts the two halves that make the naive
  // borrow lossy: the longhand read is EMPTY, and the shorthand read is the authored text.
  it("a shorthand holding a var() serializes its longhands as the empty string", () => {
    const el = node(THEMED_SHORTHAND);

    expect(el.style.getPropertyValue("background-color")).toBe("");
    expect(el.style.getPropertyValue("background-image")).toBe("");
    // …while the declaration itself is perfectly readable as authored. This asymmetry IS the bug:
    // a longhand snapshot has nothing to restore, and a `cssText` snapshot has everything.
    expect(el.style.getPropertyValue("background")).toBe("var(--c-epic-card-fill)");
    expect(el.style.cssText).toBe("background: var(--c-epic-card-fill);");
  });

  // ── THE OTHER HALF OF THE PRECONDITION: THE NAIVE BORROW, RUN SIDE BY SIDE ───────────────────
  // The test above shows the longhand READ is empty. This one shows what that does to the borrow
  // this helper replaces — and, just as importantly, pins the LIMIT of what this environment can
  // demonstrate, so nobody later reads a green file as proof of more than it actually checked.
  it("the naive longhand snapshot captures nothing, and its paint misses the declaration", () => {
    const el = node(THEMED_SHORTHAND);

    // What `const prev = el.style.backgroundColor` actually captures on a themed node: NOTHING. A
    // restore from this snapshot has no information to put back. That is the defect, in one line.
    expect(el.style.getPropertyValue("background-color")).toBe("");

    // The naive PAINT misses as well: writing the longhand leaves the node's own shorthand standing,
    // so the row still reads as its resting colour while the effect believes it is flashing.
    el.style.setProperty("background-color", FLASH_FILL);
    expect(el.style.getPropertyValue("background")).toBe("var(--c-epic-card-fill)");

    // ── AND THIS IS THE PART jsdom CANNOT SHOW YOU ─────────────────────────────────────────────
    // Clearing that rival longhand leaves the shorthand intact HERE, so the naive round trip comes
    // out clean in this environment. In real WebKit and real Chromium it does NOT: the removal
    // takes the shorthand's colour with it and the node drops to the UA `ButtonFace` default —
    // the founder's gray bar. The expectation below therefore pins JSDOM'S behaviour deliberately.
    // It is a note about the harness, not a claim that the naive borrow is safe; it is here so the
    // header's "half 2 is not reproduced" caveat is enforced rather than merely asserted in prose.
    // If it ever starts FAILING, jsdom has grown the engine behaviour and that caveat is stale.
    el.style.removeProperty("background-color");
    expect(el.style.cssText).toBe("background: var(--c-epic-card-fill);");
  });

  // ── THE ROUND TRIP ───────────────────────────────────────────────────────────────────────────
  it("restores a `background` shorthand holding a var() after a borrower paints over it", () => {
    const el = node(THEMED_SHORTHAND);

    const restore = borrowInlineStyle(el, (style) => style.setProperty("background", FLASH_FILL));
    // The borrower's paint really landed, and it really did overwrite the authored declaration —
    // without this the restore below could be "restoring" something that was never disturbed.
    expect(el.style.getPropertyValue("background")).toBe(FLASH_FILL_SERIALIZED);
    expect(el.style.cssText).not.toContain("var(--c-epic-card-fill)");

    restore();

    expect(el.style.getPropertyValue("background")).toBe("var(--c-epic-card-fill)");
    expect(el.style.cssText).toBe("background: var(--c-epic-card-fill);");
  });

  it("restores it even when the borrower shadowed it with a rival LONGHAND", () => {
    // The historical borrower's exact move: write `background-color` over a `background` shorthand.
    // In a real engine, removing that longhand afterwards takes the shorthand's colour with it —
    // which is why the restore has to re-declare the whole thing rather than undo property by
    // property.
    const el = node(THEMED_SHORTHAND);

    const restore = borrowInlineStyle(el, (style) =>
      style.setProperty("background-color", FLASH_FILL),
    );

    restore();

    expect(el.style.getPropertyValue("background")).toBe("var(--c-epic-card-fill)");
    // The rival longhand is GONE — the restore replaced the declaration, it did not merge into it.
    expect(el.style.cssText).toBe("background: var(--c-epic-card-fill);");
    expect(el.style.cssText).not.toContain("background-color");
  });

  it("restores a `border` shorthand holding a var(), not just `background`", () => {
    // The bug is a property of shorthands-with-var in general, so the guard must not be keyed to
    // one property name. `border` expands to nine longhands, every one of which reads empty here.
    const el = node("border: 1px solid var(--c-focus-ring)");
    expect(el.style.getPropertyValue("border-color")).toBe("");

    const restore = borrowInlineStyle(el, (style) =>
      style.setProperty("border", `2px dashed ${FLASH_FILL}`),
    );

    restore();

    expect(el.style.getPropertyValue("border")).toBe("1px solid var(--c-focus-ring)");
    expect(el.style.cssText).toBe("border: 1px solid var(--c-focus-ring);");
  });

  it("restores every property of a multi-property declaration, in source order", () => {
    // A borrow captures the WHOLE declaration, including properties the borrower never touches —
    // the enumeration that only saves what it is about to write is exactly the flaw.
    const before = node(
      "background: var(--c-epic-card-fill); color: var(--c-on-epic-card); transition: none",
    );
    const authored = before.style.cssText;

    const restore = borrowInlineStyle(before, (style) => {
      style.setProperty("background", FLASH_FILL);
      style.setProperty("transition", "background-color 220ms ease-out");
    });

    restore();

    expect(before.style.cssText).toBe(authored);
    expect(before.style.getPropertyValue("color")).toBe("var(--c-on-epic-card)");
  });

  it("drops properties the borrower ADDED, rather than leaving them behind", () => {
    const el = node(THEMED_SHORTHAND);

    const restore = borrowInlineStyle(el, (style) => {
      style.setProperty("opacity", "0.4");
      style.setProperty("outline", `1px solid ${FLASH_FILL}`);
    });

    restore();

    expect(el.style.getPropertyValue("opacity")).toBe("");
    expect(el.style.getPropertyValue("outline")).toBe("");
    expect(el.style.cssText).toBe("background: var(--c-epic-card-fill);");
  });

  it("restores the ABSENCE of a style attribute on a node that had none", () => {
    const el = node();
    expect(el.hasAttribute("style")).toBe(false);

    const restore = borrowInlineStyle(el, (style) => style.setProperty("background", FLASH_FILL));

    restore();

    expect(el.hasAttribute("style")).toBe(false);
  });

  it("is idempotent — restoring twice re-applies the same declaration", () => {
    const el = node(THEMED_SHORTHAND);
    const restore = borrowInlineStyle(el, (style) => style.setProperty("background", FLASH_FILL));

    restore();
    restore();

    expect(el.style.cssText).toBe("background: var(--c-epic-card-fill);");
  });

  // ══ BUG TWO: THE NODE BELONGS TO REACT, AND THE RESTORE MUST NOT STEAL IT BACK ════════════════
  // React writes inline styles by DIFFING `lastProps.style` against `nextProps.style`. So a restore
  // that re-declares the pre-borrow text unconditionally reverts a write React believes it has
  // already made — and because the next render diffs against that same bookkeeping, React never
  // writes it again and the node is stuck at a stale value indefinitely. The window here is 1.2s
  // wide and the beads store polls every 5s, so a re-render inside it is routine, not exotic.
  //
  // Every test below writes to `el.style` AFTER the borrow's paint has run, which is exactly what
  // a React re-render does to the node. None of them can pass under an unconditional restore.
  describe("when somebody else writes to the node during the borrowed window", () => {
    it("leaves the other writer's value alone instead of reverting it", () => {
      const el = node(THEMED_SHORTHAND);
      const restore = borrowInlineStyle(el, (style) => style.setProperty("background", FLASH_FILL));

      // React re-renders the row as unselected and writes the new fill onto the node.
      el.style.setProperty("background", "transparent");

      restore();

      // The authored `var()` must NOT come back: it is stale, and React would never re-write over
      // it. The node keeps what the other writer put there.
      expect(el.style.getPropertyValue("background")).toBe("transparent");
      expect(el.style.cssText).not.toContain("var(--c-epic-card-fill)");
    });

    it("still withdraws the borrower's OWN writes that the other writer did not claim", () => {
      // Deferring to the other writer must not turn the restore into a no-op — anything the borrow
      // added and nobody else touched is still the borrow's to clean up, or the effect leaks.
      const el = node(THEMED_SHORTHAND);
      const restore = borrowInlineStyle(el, (style) => {
        style.setProperty("background", FLASH_FILL);
        style.setProperty("opacity", "0.4");
      });

      el.style.setProperty("background", "transparent");

      restore();

      expect(el.style.getPropertyValue("background")).toBe("transparent"); // theirs — kept
      expect(el.style.getPropertyValue("opacity")).toBe(""); // ours — withdrawn
    });

    it("puts a property the borrower CHANGED back to its authored value, not to the paint", () => {
      // The borrower overwrote an authored property and the other writer claimed a different one,
      // so this one is still ours: it goes back to the `var()` it was authored with.
      const el = node("background: var(--c-epic-card-fill); color: var(--c-cream)");
      const restore = borrowInlineStyle(el, (style) => {
        style.setProperty("background", FLASH_FILL);
        style.setProperty("color", FLASH_FILL);
      });

      el.style.setProperty("color", "var(--c-muted)");

      restore();

      expect(el.style.getPropertyValue("background")).toBe("var(--c-epic-card-fill)"); // ours
      expect(el.style.getPropertyValue("color")).toBe("var(--c-muted)"); // theirs
    });

    it("restores the ABSENCE of a style attribute once everything left is withdrawn", () => {
      const el = node();
      const restore = borrowInlineStyle(el, (style) => {
        style.setProperty("opacity", "0.4");
        style.setProperty("outline", `1px solid ${FLASH_FILL}`);
      });

      // The other writer REMOVES one of the painted properties — what a React re-render does when
      // a conditional style property flips off. The declaration now differs from the one the borrow
      // left behind, so this takes the interference path and not the wholesale one...
      el.style.removeProperty("outline");
      expect(el.style.cssText).toBe("opacity: 0.4;");

      restore();

      // ...and once the borrow withdraws the `opacity` it added, nothing is left. A node that
      // carried no `style` attribute before the borrow must not carry an empty one after it.
      expect(el.style.cssText).toBe("");
      expect(el.hasAttribute("style")).toBe(false);
    });

    // ── THE OTHER WAY A PAINT WRITES ──────────────────────────────────────────────────────────
    // `applyFlash` writes `style.transition = …` and `style.color = …` as CAMELCASE ASSIGNMENTS,
    // not through `setProperty`. Those have to be recorded too, and recorded under their CSS names
    // (`backgroundColor` is `background-color`) or the withdrawal asks the CSSOM about a property
    // that does not exist and leaves the paint standing. RED if the assignment trap stops
    // recording: the flash's `transition` and fill are still on the node after the restore.
    it("records a camelCased assignment under its CSS name, not only setProperty", () => {
      const el = node(THEMED_SHORTHAND);

      const restore = borrowInlineStyle(el, (style) => {
        style.transition = "background-color 220ms ease-out";
        style.backgroundColor = FLASH_FILL;
      });
      expect(el.style.getPropertyValue("background-color")).toBe(FLASH_FILL_SERIALIZED);

      el.style.setProperty("color", "var(--c-muted)");

      restore();

      expect(el.style.getPropertyValue("transition")).toBe(""); // ours, added — withdrawn
      expect(el.style.getPropertyValue("background-color")).toBe(""); // ours, added — withdrawn
      expect(el.style.getPropertyValue("color")).toBe("var(--c-muted)"); // theirs — kept
    });

    // ── THE CONCRETE ROW, END TO END ───────────────────────────────────────────────────────────
    // `EpicRow` renders `background`, `border-left` and `color` off one `selected` flag, and the
    // reveal flash borrows the row while it is selected. Click a sibling inside the 1.2s window and
    // React repaints THIS row unselected. An unconditional restore then puts the selected look back
    // permanently — a row that paints as focused next to the row that actually is.
    it("does not resurrect a selected row's look after React repaints it unselected", () => {
      const selected =
        "background: var(--c-epic-card-fill); border-left: 2px solid var(--c-teal-ink); " +
        "color: var(--c-cream)";
      const el = node(selected);

      const restore = borrowInlineStyle(el, (style) => {
        style.setProperty("background", "var(--c-epic-pill-fill)");
        style.setProperty("color", "var(--c-on-epic-pill-fill)");
      });

      // React's re-render: every property the `selected` flag drives, written together.
      el.style.setProperty("background", "transparent");
      el.style.setProperty("border-left", "2px solid transparent");
      el.style.setProperty("color", "var(--c-muted)");

      restore();

      expect(el.style.getPropertyValue("background")).toBe("transparent");
      expect(el.style.getPropertyValue("border-left")).toBe("2px solid transparent");
      expect(el.style.getPropertyValue("color")).toBe("var(--c-muted)");
      // ...and no trace of the selected look is left anywhere in the declaration.
      expect(el.style.cssText).not.toContain("var(--c-epic-card-fill)");
      expect(el.style.cssText).not.toContain("var(--c-teal-ink)");
      expect(el.style.cssText).not.toContain("var(--c-cream)");
    });

    // ── A REMOVAL IS A WRITE, AND A DIFF CANNOT SEE ONE ───────────────────────────────────────
    // A property the paint REMOVED is simply absent from the painted declaration, so a withdrawal
    // that recovers "what was mine" by walking that declaration can never find it — it is the one
    // write that leaves no trace to enumerate. Recording the NAMES as they are written finds it
    // like any other. RED against the enumerate-the-declaration implementation: `opacity` comes
    // back as `""`.
    it("puts back a property the paint REMOVED, which no diff of the declaration can see", () => {
      const el = node(`${THEMED_SHORTHAND}; opacity: 0.5`);

      const restore = borrowInlineStyle(el, (style) => {
        style.removeProperty("opacity");
        style.setProperty("background", FLASH_FILL);
      });

      // Somebody else writes an unrelated property — the interference path, where the withdrawal
      // is per-property and the wholesale re-declaration is off the table.
      el.style.setProperty("color", "var(--c-muted)");

      restore();

      expect(el.style.getPropertyValue("opacity")).toBe("0.5"); // ours, removed — and put back
      expect(el.style.getPropertyValue("background")).toBe("var(--c-epic-card-fill)"); // ours
      expect(el.style.getPropertyValue("color")).toBe("var(--c-muted)"); // theirs — kept
    });

    // The `!important` an authored declaration can carry has to survive the round trip too: a
    // withdrawal that re-declares the value without its priority silently downgrades it, and the
    // node then loses to a stylesheet rule it used to beat.
    it("withdraws to the authored value WITH its priority, not just its text", () => {
      const el = node("background: var(--c-epic-card-fill) !important");

      const restore = borrowInlineStyle(el, (style) => {
        style.setProperty("background", FLASH_FILL);
        style.setProperty("opacity", "0.4");
      });

      el.style.setProperty("color", "var(--c-muted)");

      restore();

      expect(el.style.getPropertyValue("background")).toBe("var(--c-epic-card-fill)");
      expect(el.style.getPropertyPriority("background")).toBe("important");
    });
  });

  // ══ THE HALF jsdom CANNOT EXPRESS, MODELLED EXPLICITLY ═══════════════════════════════════════
  // Everything above runs against jsdom's CSSOM, which keeps an unparsed `var()` shorthand verbatim
  // under the SHORTHAND name — so `style.item(0)` reads `"background"` there. Real engines do the
  // opposite, and it is the difference that makes or breaks the withdrawal: a shorthand carrying a
  // `var()` gives each of its LONGHANDS a pending-substitution value, the declaration enumerates
  // those longhands, and reading one back serializes as `""` (measured in WebKit and Chromium —
  // `EpicsColumn.revealFlash.test.tsx` carries the transcript).
  //
  // So the engine behaviour is MODELLED here rather than borrowed from the environment. This is a
  // model and is labelled as one: it encodes exactly the two facts above for `background` and
  // refuses anything it has not been taught, so it cannot quietly answer a question it does not
  // know. What it buys is that the two shapes below — the ones that make the real app wrong and
  // that no jsdom test can reach — are executable.
  describe("against a CSSOM that models a real engine's pending-substitution longhands", () => {
    const BACKGROUND_LONGHANDS = [
      "background-image",
      "background-position",
      "background-size",
      "background-repeat",
      "background-attachment",
      "background-origin",
      "background-clip",
      "background-color",
    ] as const;
    /** What each of those reads back when `background` was set to a PLAIN value — the shorthand's
     *  own colour lands on `background-color` and the rest sit at their initial values. */
    const PLAIN_LONGHAND_VALUES: Record<string, string> = {
      "background-image": "none",
      "background-position": "0% 0%",
      "background-size": "auto",
      "background-repeat": "repeat",
      "background-attachment": "scroll",
      "background-origin": "padding-box",
      "background-clip": "border-box",
    };

    /** A declaration with a real engine's shorthand bookkeeping for `background`, and nothing else
     *  modelled. Longhand ENUMERATION plus EMPTY longhand reads under a `var()` are the whole of
     *  what it exists to express; every other property behaves like an ordinary longhand. */
    const isBackgroundLonghand = (name: string): boolean =>
      BACKGROUND_LONGHANDS.includes(name as (typeof BACKGROUND_LONGHANDS)[number]);

    class EngineDeclaration {
      private order: string[] = [];
      private values = new Map<string, { value: string; priority: string }>();
      /** A longhand written or removed OVER a declared `background` shorthand. `null` is a
       *  removal — and a removed longhand does NOT fall back to the shorthand's pending value: the
       *  colour is gone, which is the whole of `sparkle-huw924.15`. */
      private overrides = new Map<string, { value: string; priority: string } | null>();

      private isPending(): boolean {
        const bg = this.values.get("background");
        return bg !== undefined && bg.value.includes("var(");
      }

      private shadowed(name: string): boolean {
        return isBackgroundLonghand(name) && this.values.has("background");
      }

      setProperty(name: string, value: string, priority = ""): void {
        if (this.shadowed(name)) {
          this.overrides.set(name, { value, priority });
          return;
        }
        if (name === "background") {
          // A SHORTHAND WRITE REPLACES STANDING LONGHANDS of its family — the authored
          // `background-color` a React `style={{ backgroundColor }}` emits is gone the moment the
          // paint writes `background`, which is what makes its withdrawal destructive.
          this.overrides.clear();
          this.order = this.order.filter((n) => !isBackgroundLonghand(n));
          for (const longhand of BACKGROUND_LONGHANDS) this.values.delete(longhand);
        }
        if (!this.values.has(name)) this.order.push(name);
        this.values.set(name, { value, priority });
      }

      removeProperty(name: string): string {
        const previous = this.getPropertyValue(name);
        if (this.shadowed(name)) {
          this.overrides.set(name, null);
          return previous;
        }
        if (name === "background") this.overrides.clear();
        this.values.delete(name);
        this.order = this.order.filter((n) => n !== name);
        return previous;
      }

      getPropertyValue(name: string): string {
        if (name === "background") {
          const bg = this.values.get("background");
          if (bg === undefined) return "";
          // A RIVAL LONGHAND MAKES THE SHORTHAND UNSERIALIZABLE — measured, and the reason the
          // original defect could not be seen from the shorthand side once the flash had painted.
          return this.overrides.size === 0 ? bg.value : "";
        }
        const override = this.overrides.get(name);
        if (override !== undefined) return override === null ? "" : override.value;
        const own = this.values.get(name);
        if (own !== undefined) return own.value;
        if (!isBackgroundLonghand(name)) return "";
        const bg = this.values.get("background");
        if (bg === undefined) return "";
        // THE ONE LINE THE WHOLE MODEL EXISTS FOR: a pending-substitution longhand reads EMPTY.
        if (this.isPending()) return "";
        return name === "background-color" ? bg.value : (PLAIN_LONGHAND_VALUES[name] ?? "");
      }

      getPropertyPriority(name: string): string {
        const override = this.overrides.get(name);
        if (override !== undefined && override !== null) return override.priority;
        return this.values.get(name)?.priority ?? "";
      }

      /** Longhands, never the shorthand — the enumeration that makes the naive withdrawal wrong.
       *  A longhand REMOVED over the shorthand drops out of it, exactly as it does in the engine. */
      private get enumerated(): string[] {
        return this.order.flatMap((n) =>
          n === "background"
            ? BACKGROUND_LONGHANDS.filter((l) => this.overrides.get(l) !== null)
            : [n],
        );
      }

      get length(): number {
        return this.enumerated.length;
      }

      item(i: number): string {
        return this.enumerated[i] ?? "";
      }

      get cssText(): string {
        const parts: string[] = [];
        for (const n of this.order) {
          if (n === "background" && this.overrides.size > 0) {
            // Once a rival longhand exists the engine can no longer print the shorthand, so the
            // family serializes property by property.
            for (const longhand of BACKGROUND_LONGHANDS) {
              const value = this.getPropertyValue(longhand);
              if (value !== "") parts.push(`${longhand}: ${value};`);
            }
            continue;
          }
          const { value, priority } = this.values.get(n) ?? { value: "", priority: "" };
          parts.push(`${n}: ${value}${priority === "" ? "" : ` !${priority}`};`);
        }
        return parts.join(" ");
      }

      set cssText(text: string) {
        this.order = [];
        this.values = new Map();
        this.overrides = new Map();
        for (const part of text.split(";")) {
          const at = part.indexOf(":");
          if (at === -1) continue;
          this.setProperty(part.slice(0, at).trim(), part.slice(at + 1).trim());
        }
      }
    }

    /** The same shape `borrowInlineStyle` uses of a real element, over the modelled declaration. */
    function engineNode(cssText: string): { el: HTMLElement; style: EngineDeclaration } {
      const style = new EngineDeclaration();
      style.cssText = cssText;
      let hasStyleAttribute = cssText !== "";
      const el = {
        style,
        hasAttribute: (name: string) => name === "style" && hasStyleAttribute,
        removeAttribute: (name: string) => {
          if (name === "style") hasStyleAttribute = false;
        },
        ownerDocument: { createElement: () => ({ style: new EngineDeclaration() }) },
      };
      return { el: el as unknown as HTMLElement, style };
    }

    // The model itself is asserted before anything is built on it — a double that does not
    // reproduce the defect would make every test under it vacuous.
    it("models the engine: a var() shorthand enumerates longhands that read EMPTY", () => {
      const { style } = engineNode(THEMED_SHORTHAND);

      expect(style.getPropertyValue("background")).toBe("var(--c-epic-card-fill)");
      expect(style.getPropertyValue("background-color")).toBe("");
      expect(style.length).toBe(BACKGROUND_LONGHANDS.length);
      expect(style.item(0)).toBe("background-image");
    });

    // ── SHAPE 1: var() OVER var() — THE SHIPPED CALLER ────────────────────────────────────────
    // `EpicRow` is authored `background: var(--c-epic-card-fill)` and the flash paints
    // `var(--c-epic-pill-fill)`. Both sides are pending-substitution, so a diff of the declaration
    // sees NOTHING change and has nothing to withdraw — the row keeps the flash fill permanently,
    // and React never repaints it because its `background` prop never changed.
    it("withdraws a var() shorthand painted over a var() shorthand", () => {
      const { el, style } = engineNode(THEMED_SHORTHAND);

      const restore = borrowInlineStyle(el, (s) =>
        s.setProperty("background", "var(--c-epic-pill-fill)"),
      );
      expect(style.getPropertyValue("background")).toBe("var(--c-epic-pill-fill)");

      // Somebody else writes — the interference path, where only the borrow's own writes go back.
      style.setProperty("color", "var(--c-muted)");

      restore();

      expect(style.getPropertyValue("background")).toBe("var(--c-epic-card-fill)");
      expect(style.getPropertyValue("color")).toBe("var(--c-muted)");
    });

    // ── SHAPE 2: A PLAIN VALUE OVER var() — THE GRAY BAR, REBUILT INSIDE ITS OWN FIX ──────────
    // Here the painted longhands ARE visible to a diff and their authored counterparts read `""`,
    // so the naive withdrawal REMOVES them and leaves `background` undeclared — which is
    // `sparkle-huw924.15` exactly: the `<button>` falls back to the UA default, permanently.
    it("withdraws a plain value painted over a var() shorthand, without destroying it", () => {
      const { el, style } = engineNode(THEMED_SHORTHAND);

      const restore = borrowInlineStyle(el, (s) => s.setProperty("background", FLASH_FILL));
      expect(style.getPropertyValue("background-color")).toBe(FLASH_FILL);

      style.setProperty("color", "var(--c-muted)");

      restore();

      expect(style.getPropertyValue("background")).toBe("var(--c-epic-card-fill)");
      expect(style.cssText).toContain("var(--c-epic-card-fill)");
    });

    // ── SHAPE 3: A LONGHAND OVER var() — RECORDING THE NAME IS ONLY HALF OF IT ────────────────
    // Recording fixes WHICH property was the borrower's. It does not fix WHAT to put back: the
    // withdrawal reads that with `priorStyle.getPropertyValue("background-color")`, which under an
    // authored `background: var(…)` is `""` — pending substitution, from the value side. Treat that
    // `""` as "never authored" and the withdrawal REMOVES the rival longhand, which takes the
    // shorthand's colour with it. `sparkle-huw924.15`, reached by a caller doing what the header
    // used to say was fine.
    it("withdraws a LONGHAND painted over a var() shorthand without taking the fill with it", () => {
      const { el, style } = engineNode(THEMED_SHORTHAND);

      const restore = borrowInlineStyle(el, (s) => s.setProperty("background-color", FLASH_FILL));
      expect(style.getPropertyValue("background-color")).toBe(FLASH_FILL);
      // ...and the shorthand can no longer be read back at all while the rival longhand stands.
      expect(style.getPropertyValue("background")).toBe("");

      style.setProperty("color", "var(--c-muted)");

      restore();

      expect(style.getPropertyValue("background")).toBe("var(--c-epic-card-fill)");
      expect(style.getPropertyValue("color")).toBe("var(--c-muted)");
    });

    // ── SHAPE 4: AN UNNAMEABLE PAINT MUST NOT BE GUESSED AT ───────────────────────────────────
    // `style.cssText = …` names no property. Enumerating the declaration afterwards to find out
    // what was written hands the withdrawal eight longhands whose authored values all read `""`,
    // so it removes all eight and the authored shorthand is destroyed — a worse outcome than
    // recording nothing at all. Rule 3 says don't write `cssText`; this says what happens if you
    // do: the paint stands, and the declaration survives.
    it("withdraws NOTHING rather than shredding the declaration when the paint set cssText", () => {
      const { el, style } = engineNode(THEMED_SHORTHAND);

      const restore = borrowInlineStyle(el, (s) => {
        s.cssText = "background: var(--c-epic-pill-fill)";
      });

      style.setProperty("color", "var(--c-muted)");

      restore();

      expect(style.getPropertyValue("background")).toBe("var(--c-epic-pill-fill)");
      expect(style.getPropertyValue("color")).toBe("var(--c-muted)");
    });

    // ── SHAPE 5: THE INVERSE — A SHORTHAND OVER AN AUTHORED LONGHAND ──────────────────────────
    // The other direction of the same fact, and the one an ordinary React `style={{ backgroundColor }}`
    // produces: the node is authored with a LONGHAND, the paint writes the shorthand exactly as
    // rule 1 recommends, and `priorStyle.getPropertyValue("background")` is `""` because a lone
    // longhand does not serialize as a shorthand. A withdrawal that reads that as "never authored"
    // calls `removeProperty("background")`, which clears the WHOLE family — the authored fill
    // included. React never rewrites it: its bookkeeping says `backgroundColor` is already applied.
    it("withdraws a SHORTHAND painted over an authored LONGHAND without clearing the family", () => {
      const { el, style } = engineNode("background-color: #c0392b");
      expect(style.getPropertyValue("background")).toBe("");

      const restore = borrowInlineStyle(el, (s) =>
        s.setProperty("background", "var(--c-epic-pill-fill)"),
      );
      expect(style.getPropertyValue("background")).toBe("var(--c-epic-pill-fill)");

      style.setProperty("color", "var(--c-muted)");

      restore();

      expect(style.getPropertyValue("background-color")).toBe("#c0392b");
      expect(style.getPropertyValue("color")).toBe("var(--c-muted)");
    });

    // ── SHAPE 6: RE-DECLARING INTO A FAMILY IS A WIDE WRITE ───────────────────────────────────
    // Putting a shorthand back lands on every longhand in its family, including one the OTHER
    // writer set during the window — which is bug two rebuilt inside bug three's fix, and bug two
    // is the worse of the two because React cannot recover from being reverted. So when a sibling
    // has moved since the paint, this borrow's property is left standing instead. The leak is
    // deliberate and is asserted, so nobody "fixes" it back into a revert.
    it("leaves the family alone when the other writer holds a sibling longhand", () => {
      const { el, style } = engineNode(THEMED_SHORTHAND);

      const restore = borrowInlineStyle(el, (s) => s.setProperty("background-color", FLASH_FILL));

      // React writes a SIBLING longhand of the same family during the window.
      style.setProperty("background-image", "url(a.png)");

      restore();

      expect(style.getPropertyValue("background-image")).toBe("url(a.png)"); // theirs — never reverted
      expect(style.getPropertyValue("background-color")).toBe(FLASH_FILL); // ours — leaked, on purpose
    });
  });
});
