// Rule test for sparkle-a11y/no-presentational-children-role (bead sparkle-2mwl2m).
//
// The defect: `BeadCard`'s root carried `role="button"` to make the whole card clickable. ARIA gives
// the `button` role PRESENTATIONAL CHILDREN, so assistive tech flattened the card to one name and
// dropped the announced semantics of every control inside it — and the single `role` slot displaced
// the card's own `role="status"`, so a card posted into the concierge thread stopped announcing
// itself. Nothing rendered differently and no test failed.
//
// `BeadCard.test.tsx` pins that ONE surface by ancestry. This pins the CLASS: RuleTester drives the
// rule directly, so the shape is caught wherever it is written next.
import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import rule from "../../../../eslint-rules/no-presentational-children-role.mjs";

const rt = new RuleTester({
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

describe("no-presentational-children-role rule", () => {
  it("flags a children-presentational role wrapping interactive content", () => {
    rt.run("no-presentational-children-role", rule, {
      valid: [
        // THE SHIPPED FIX. The card body keeps the click as a mouse convenience with no role of its
        // own to lose, the live region survives, and the disclosure is a real nested <button>.
        `const A = <span role="status" onClick={t}><button aria-expanded={x}>Title</button></span>;`,
        // A leaf trigger — the whole point of `role="button"`, and never the defect.
        `const A = <span role="button" tabIndex={0} onClick={t}>P2</span>;`,
        // A clickable wrapper with NO role is exactly what the message asks for.
        `const A = <div onClick={t}><button>Build it</button></div>;`,
        // Non-interactive content inside a button role is what the role is FOR.
        `const A = <div role="button" tabIndex={0}><span style={s} aria-hidden /></div>;`,
        // tabIndex={-1} is a focus target, not a tab stop, so it is not a silenced control.
        `const A = <div role="button"><span tabIndex={-1}>x</span></div>;`,
        // An <a> with no href is not a link.
        `const A = <div role="button"><a>not a link</a></div>;`,
        // A role this rule does not police.
        `const A = <div role="group"><button>a</button></div>;`,
        // AN ATTRIBUTE IS NOT THIS ELEMENT'S SUBTREE. A control handed to a prop is rendered by the
        // callee, wherever that puts it, so it is out of scope here.
        `const A = <div role="button" renderIcon={<button>x</button>} />;`,
        // DOCUMENTED LIMIT: a custom component's rendering is not decidable from this file, so it is
        // deliberately not flagged. The paired ancestry assertion in the component's own test covers
        // it; see the rule header.
        `const A = <div role="button"><AgentPill id={i} /></div>;`,
        // ══ A ROLE THAT IS NOT A LITERAL — the gap that made the guard blind to its own subject ══
        // `BeadCard`'s root is `role={spec.role}`, fed from a module-level map. Resolving only a
        // string literal meant the ONE file this rule exists for could never be reported, and the
        // "with `allow` emptied only these four files report" sweep read as a coverage proof while
        // BeadCard was absent for being UNANALYZABLE. These pin the resolution, both directions.
        //
        // A resolved role that is NOT children-presentational stays silent — this is BeadCard as it
        // actually ships, and it must not become a false positive.
        `const CHROME = { concierge: { role: "status" } };
         const A = <div role={CHROME.concierge.role}><button>x</button></div>;`,
        // A role arriving as a PROP is not decidable in this file. Still the documented floor: the
        // rule reports nothing rather than guessing, and the component's own render test covers it.
        `const A = ({ spec }) => <div role={spec.role}><button>x</button></div>;`,
        // A REASSIGNED binding is not a constant, so its initializer does not describe its value.
        `let r = "button"; r = pick(); const A = <div role={r}><button>x</button></div>;`,
        // The baseline. `allow` is a suffix match on the filename, for debt that predates the rule.
        {
          code: `const A = <div role="button"><button>Approve</button></div>;`,
          filename: "/repo/apps/desktop/src/components/Concierge/NudgeCard.tsx",
          options: [{ allow: ["src/components/Concierge/NudgeCard.tsx"] }],
        },
      ],
      invalid: [
        // THE EXACT SHAPE THAT SHIPPED.
        {
          code: `const A = <span role="button" tabIndex={0}><button>Build it</button></span>;`,
          errors: [{ messageId: "silenced" }],
        },
        // Depth is not a defence — the control is silenced however deep it sits.
        {
          code: `const A = <div role="button"><div><div><a href={u}>Open</a></div></div></div>;`,
          errors: [{ messageId: "silenced" }],
        },
        // The class is the ROLE, not the word "button": every presentational-children role does it.
        {
          code: `const A = <div role="tab" tabIndex={0}><button aria-label="Close">x</button></div>;`,
          errors: [{ messageId: "silenced" }],
        },
        {
          code: `const A = <span role="img"><input value={v} /></span>;`,
          errors: [{ messageId: "silenced" }],
        },
        {
          code: `const A = <div role="switch"><textarea /></div>;`,
          errors: [{ messageId: "silenced" }],
        },
        // A nested ARIA control is silenced exactly as a native one is.
        {
          code: `const A = <div role="checkbox"><span role="button" tabIndex={0}>P2</span></div>;`,
          errors: [{ messageId: "silenced" }],
        },
        // …and so is anything that was made a tab stop, which is how a card grows one later.
        {
          code: `const A = <div role="button"><div tabIndex={0} onKeyDown={k} /></div>;`,
          errors: [{ messageId: "silenced" }],
        },
        // ══ THE WRAPPED FORMS — the gap a mutation run found ═══════════════════════════════════
        // A card's controls are almost never bare JSX children. An earlier draft of this rule
        // recursed only into `JSXElement` children, so every one of these passed — including
        // BeadCard itself with the defect re-applied, which is the one case the rule exists for.
        {
          code: `const A = <div role="button">{expanded && <button>Build it</button>}</div>;`,
          errors: [{ messageId: "silenced" }],
        },
        {
          code: `const A = <div role="button">{rows.map((r) => <button key={r.id}>{r.t}</button>)}</div>;`,
          errors: [{ messageId: "silenced" }],
        },
        {
          code: `const A = <div role="button">{cond ? <a href={u}>Open</a> : null}</div>;`,
          errors: [{ messageId: "silenced" }],
        },
        {
          code: `const A = <div role="button"><><span /><button>x</button></></div>;`,
          errors: [{ messageId: "silenced" }],
        },
        // ══ THE NON-LITERAL ROLE FORMS — each one silent before this ═════════════════════════════
        // EXACTLY `BeadCard`'s shape: a module-level chrome map, read through a member expression.
        // Flip one entry's `role` and the guard must speak.
        {
          code: `const CHROME = { concierge: { role: "button" } };
                 const A = <div role={CHROME.concierge.role}><button>Build it</button></div>;`,
          errors: [{ messageId: "silenced" }],
        },
        // A COMPUTED key nobody can name unions every property — a role reachable on ANY path is
        // seen. Over-approximating is the safe direction: a false positive is loud and fixable, the
        // silence it replaces was neither.
        {
          code: `const CHROME = { board: { role: "status" }, concierge: { role: "button" } };
                 const A = <div role={CHROME[chrome].role}><button>Build it</button></div>;`,
          errors: [{ messageId: "silenced" }],
        },
        // TWO REFERENCES TO ONE BINDING IN ONE ROLE EXPRESSION (roborev 70543). Both arms resolve
        // through the SAME `CHROME` object literal, so a shared VISITED set made the second arm
        // yield nothing and `"button"` never surfaced — silence, on the exact union guarantee the
        // widening promises. The suite's other ternary uses two distinct Literal nodes and cannot
        // reach this. Order matters: the presentational role must be in the arm walked SECOND.
        {
          code: `const CHROME = { board: { role: "status" }, concierge: { role: "button" } };
                 const A = <div role={flag ? CHROME.board.role : CHROME.concierge.role}>
                             <button>Build it</button>
                           </div>;`,
          errors: [{ messageId: "silenced" }],
        },
        // …and the same shape through a logical fallback.
        {
          code: `const CHROME = { board: { role: "status" }, concierge: { role: "button" } };
                 const A = <div role={CHROME.board.role && CHROME.concierge.role}>
                             <button>Build it</button>
                           </div>;`,
          errors: [{ messageId: "silenced" }],
        },
        // A conditional contributes BOTH branches.
        {
          code: `const A = <div role={clickable ? "button" : undefined}><button>x</button></div>;`,
          errors: [{ messageId: "silenced" }],
        },
        // …and so does a logical fallback.
        {
          code: `const A = <div role={override || "tab"}><a href={u}>Open</a></div>;`,
          errors: [{ messageId: "silenced" }],
        },
        // A plain const binding.
        {
          code: `const R = "switch"; const A = <div role={R}><textarea /></div>;`,
          errors: [{ messageId: "silenced" }],
        },
        // The DESCENDANT's role is resolved the same way — a nested control hidden behind a const
        // was equally invisible.
        {
          code: `const R = "button";
                 const A = <div role="checkbox"><span role={R} tabIndex={0}>P2</span></div>;`,
          errors: [{ messageId: "silenced" }],
        },
        // An `allow` entry for a DIFFERENT file does not exempt this one.
        {
          code: `const A = <div role="button"><button>Approve</button></div>;`,
          filename: "/repo/apps/desktop/src/components/BeadCard/BeadCard.tsx",
          options: [{ allow: ["src/components/Concierge/NudgeCard.tsx"] }],
          errors: [{ messageId: "silenced" }],
        },
      ],
    });
  });
});
