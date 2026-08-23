# HumaneBench — vendored provenance

This directory is a **fork** of upstream HumaneBench, copied in rather than installed. Treat every
file here as third-party code: do not hand-edit it to fix a Sparkle-side problem, and do not
re-vendor it by overwriting.

| | |
| --- | --- |
| Upstream | <https://github.com/buildinghumanetech/humanebench> |
| Vendored commit | `d94963dcafd1b021f144668b8fbc79570d8f3971` (authored 2026-05-22) |
| Vendored on | 2026-08-22 |
| Licence | Apache-2.0 (`LICENSE-Apache-2.0.txt`, upstream root `LICENSE` verbatim) |

**Licence discrepancy, unresolved:** upstream's root `LICENSE` is Apache-2.0, but
`evaluator/package.json` — the manifest beside the file vendored as `humanebench_evaluator.ts` —
declares `"license": "MIT"`. We did not guess; we comply with Apache-2.0, which also satisfies MIT.
See `THIRD_PARTY_NOTICES.md` at the repository root.

## Files, and how each maps upstream

| File | Upstream path | Upstream sha256 (of the fetched bytes) | Form |
| --- | --- | --- | --- |
| `humanebench_evaluator.ts` | `evaluator/humanebench_evaluator.ts` | `181d56f3749dc63934168aab3ae582efc3c50c7b8c68164c981f48588afbda0d` | verbatim **except one patch** |
| `rubric_v3.md` | `rubrics/rubric_v3.md` | `c3d9cbe20db76e0779b537db650c12fc2fd2b9d370c7da6be75c9d7277c5cf43` | verbatim |
| `principles.ts` | `humanebench/humane_patterns.py` | `c4aac3c2ea8dc8724ceceb937b8abc8baaaa0c0ef6091a6975c11d0eeafbd7a6` | transcribed (see below) |
| `LICENSE-Apache-2.0.txt` | `LICENSE` | `f1b40669da96fa683ec797302c0357b0fdca303285e89764c0789e7fe88275c8` | verbatim |

`principles.ts` is a **transcription, not a paraphrase.** Upstream declares the eight principles as
pydantic models in Python; this is the same eight records as a frozen TypeScript record. Each `id`,
`display_name` and `description` was extracted by parsing upstream's Python AST (so the implicit
string concatenation and the `\n` escapes evaluate exactly as Python evaluates them) and then
verified equal to the source strings byte-for-byte. The bullet scoring criteria inside each
description are part of the prompt Sparkle builds; nothing here may be built on a re-wording.

Not vendored: upstream's Python / AISI-Inspect harness. This repository has never installed a
Python package, and the standalone TypeScript evaluator scores all eight principles in one call,
which is all Sparkle needs.

## Our one local patch

Marked inline as `// SPARKLE PATCH (humanebench-gate)`, in `formatPrompt`. It is one edit closing
**two** independent silent-corruption hazards in upstream's

    HUMANEBENCH_TEMPLATE
      .replace('{user_prompt}', userPrompt)
      .replace('{message_content}', messageContent)

Both matter because Sparkle feeds this evaluator **source code and unified diffs** — payloads that
are dense in `$` *and* that can contain the placeholder tokens verbatim.

1. **`$`-pattern interpretation.** A replacement **string** interprets `$$`, `$&`, `` $` ``, `$'`
   and `$1`–`$99` inside itself, so those sequences in the payload are rewritten before the
   evaluator model sees them. Fixed by passing a replacer **function**, whose return value is
   inserted verbatim.
2. **Payload-controlled placeholder capture.** The two substitutions ran **sequentially**, each
   replacing the **first** occurrence, and `{user_prompt}` precedes `{message_content}` in the
   template. So a user-prompt payload containing the literal text `{message_content}` was spliced
   in by pass 1, and pass 2 then matched *the placeholder that arrived from the payload*: the
   assistant response landed inside the **user-prompt** section and the real response slot was left
   as literal placeholder text. Attacker-influenced diff content could relocate or suppress the
   `## LLM Assistant's Response` section entirely. Fixed by doing both substitutions in **one pass**
   over an alternation — `replace` never re-scans its own replacement output, so inserted text can
   never be read as a placeholder.

Current form:

    const SLOTS: Record<string, string> = {
      '{user_prompt}': userPrompt,
      '{message_content}': messageContent,
    };
    return HUMANEBENCH_TEMPLATE.replace(
      /\{user_prompt\}|\{message_content\}/g,
      (placeholder) => SLOTS[placeholder],
    );

The replacer must stay a **function** (hazard 1) and the pass must stay **single** (hazard 2);
either regression alone re-opens its half. Rationale in full is in the patch comment itself.

**Both hazards exist upstream**, at upstream commit
`d94963dcafd1b021f144668b8fbc79570d8f3971`, and are worth contributing back. Upstream's
`CONTRIBUTING.md` requires an issue and maintainer agreement before code, so that conversation has
to happen first — it has **not** been opened from Sparkle. Anything needed to write it is here and
in `PRD/sparkle/humanebench-vendor.md`: the two failure mechanisms above, the reproductions in
`formatPrompt.test.ts`, and the one-pass replacement.

## Re-vendoring

1. Fetch the new upstream bytes:
   `gh api "repos/buildinghumanetech/humanebench/contents/<path>?ref=<sha>" --jq '.content' | base64 -d`
2. **Re-apply the SPARKLE PATCH.** `cargo test humanebench` fails loudly if you forget — that
   guard exists because a naive overwrite reverts the patch with no other symptom.
3. Re-run `pnpm --filter @sparkle/desktop exec vitest run src-tauri/resources/humanebench/` and
   `cargo test --lib humanebench` from `apps/desktop/src-tauri`.
4. Update the commit sha, date and checksums here **and** in `THIRD_PARTY_NOTICES.md`, and add a
   `PRD/sparkle/humanebench-vendor.md` entry.

## Guards

- `apps/desktop/src-tauri/src/humanebench_vendor.rs` — `include_str!`s these files and asserts the
  eight canonical ids, the four score tiers, the absence of a `0.0` tier, and that the patch is
  still applied: the marker, the single-pass alternation, the replacer function, **and** the
  absence of any per-placeholder `.replace('{user_prompt}', …)` call (which is upstream's shape in
  both of its forms).
- `formatPrompt.test.ts` — drives the real vendored `formatPrompt` bytes and asserts a `$`-dense
  payload survives byte-for-byte, that a payload containing a placeholder token cannot capture the
  other slot in either direction, and that a payload carrying both hazards at once survives.
