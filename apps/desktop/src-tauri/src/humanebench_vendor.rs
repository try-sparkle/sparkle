//! Drift guard for the vendored HumaneBench evaluator.
//!
//! `apps/desktop/src-tauri/resources/humanebench/` holds a FORK of upstream HumaneBench
//! (<https://github.com/buildinghumanetech/humanebench>), vendored at commit
//! `d94963dcafd1b021f144668b8fbc79570d8f3971`. A fork is only safe while someone can tell it has
//! drifted, and the two ways it drifts silently are (a) a re-vendor that reverts our one local
//! patch and (b) upstream changing the principle set or the scoring scale our gate threshold is
//! calibrated against.
//!
//! Neither is visible to any other test in this repo: the vendored files are outside
//! `apps/desktop/tsconfig.json`'s `include`, so tsc never reads them, and the evaluator is a
//! standalone CLI nothing here imports. So the assertions live here, in the Rust build, where
//! they gate every `cargo test`.
//!
//! Modelled on `attention::tests::the_scanned_file_is_the_one_that_actually_gets_compiled`: the
//! guard `include_str!`s the very files it asserts about, so it cannot go stale against a file
//! that moved out from under it — a missing path is a compile error, not a silently-skipped test.
//!
//! Everything lives under `#[cfg(test)]` so the vendored text is embedded in the test binary
//! only, never in the shipped app.

#[cfg(test)]
mod tests {
    /// The vendored files, by the same path the repository holds them at. `include_str!` is
    /// resolved at COMPILE time relative to this source file, so if any of these is moved,
    /// renamed or deleted the build fails outright.
    const PRINCIPLES_TS: &str = include_str!("../resources/humanebench/principles.ts");
    const RUBRIC_V3: &str = include_str!("../resources/humanebench/rubric_v3.md");
    const EVALUATOR_TS: &str = include_str!("../resources/humanebench/humanebench_evaluator.ts");

    /// The eight canonical HumaneBench principle ids. This list is the CONTRACT: Sparkle's gate
    /// reports one score per id, so a ninth principle or a renamed id changes the shape of every
    /// stored result. Hard-coded here on purpose — reading them out of `principles.ts` would make
    /// the guard agree with whatever that file happens to say, which is not a check.
    const CANONICAL_IDS: [&str; 8] = [
        "respect-user-attention",
        "enable-meaningful-choices",
        "enhance-human-capabilities",
        "protect-dignity-and-safety",
        "foster-healthy-relationships",
        "prioritize-long-term-wellbeing",
        "be-transparent-and-honest",
        "design-for-equity-and-inclusion",
    ];

    /// The rubric is prose written for humans: it renders negatives with an EN DASH (U+2013) and
    /// escapes the leading plus for Markdown (`\+1.0`). Fold both away so the scale can be
    /// asserted in its plain form. Idempotent, so it keeps working if upstream switches to ASCII.
    fn normalize_scale(markdown: &str) -> String {
        markdown
            .replace('\u{2013}', "-") // en dash
            .replace('\u{2014}', "-") // em dash
            .replace('\u{2212}', "-") // minus sign
            .replace("\\+", "+")
    }

    /// `//`-to-end-of-line comments, removed. The code-shape assertions below are about CODE,
    /// and the SPARKLE PATCH comment deliberately QUOTES upstream's broken call shape — that
    /// quotation is most of what makes the patch legible to the next reader. Without this fold, a
    /// raw `contains` would match the EXPLANATION of the bug instead of the bug.
    ///
    /// Deliberately crude: it does not understand string or template literals, so a `//` inside
    /// one truncates that line. Acceptable, because the only thing it feeds is the negative
    /// call-shape assertion whose target — `HUMANEBENCH_TEMPLATE.replace(…)` on a `return` line —
    /// carries no `//`. `stripping_comments_is_what_makes_the_patch_scan_meaningful` pins that it
    /// still leaves the real patch code standing.
    fn strip_line_comments(source: &str) -> String {
        source
            .lines()
            .map(|line| match line.find("//") {
                Some(i) => &line[..i],
                None => line,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn all_eight_canonical_principle_ids_are_present_in_principles_ts() {
        for id in CANONICAL_IDS {
            assert!(
                PRINCIPLES_TS.contains(&format!("\"{id}\"")),
                "vendored principles.ts no longer declares the canonical principle id {id:?}. \
                 Sparkle's gate keys every score on these eight ids; a rename or a drop silently \
                 changes the shape of every result. Re-vendor deliberately and update \
                 CANONICAL_IDS in the same commit."
            );
        }
    }

    #[test]
    fn principles_ts_declares_exactly_eight_patterns_and_no_more() {
        // A NINTH principle is as much a contract break as a missing one, and the loop above
        // cannot see it. Count the record entries, not the id mentions: each id appears three
        // times in the file (the id list, the record key, the `id:` field).
        let entries = PRINCIPLES_TS.matches("    id: \"").count();
        assert_eq!(
            entries, 8,
            "vendored principles.ts declares {entries} HumanePattern records, expected 8. \
             Upstream changed the principle set; decide deliberately what Sparkle's gate reports."
        );
    }

    #[test]
    fn the_rubric_still_carries_all_four_score_tiers() {
        let scale = normalize_scale(RUBRIC_V3);
        for tier in ["+1.0", "+0.5", "-0.5", "-1.0"] {
            assert!(
                scale.contains(tier),
                "vendored rubric_v3.md no longer defines the {tier} tier. The gate maps model \
                 output onto exactly these four values (see VALID_SCORES in \
                 humanebench_evaluator.ts); a changed scale invalidates the stored scores."
            );
        }
    }

    #[test]
    fn the_rubric_has_no_zero_tier() {
        // LOAD-BEARING. The HumaneBench scale is deliberately zero-free — there is no "neutral"
        // score, every principle lands on one side of the line. Sparkle's gate threshold is 0.5,
        // which is only meaningful because 0.0 cannot occur: a 0.0 tier would sit BELOW the
        // threshold and would quietly start failing responses upstream considers unremarkable.
        // If upstream ever introduces one, this must be a deliberate re-think of the threshold,
        // not a silent re-vendor.
        let scale = normalize_scale(RUBRIC_V3);
        assert!(
            !scale.contains("0.0"),
            "vendored rubric_v3.md now mentions a 0.0 score. The HumaneBench scale had no zero \
             tier, and Sparkle's 0.5 gate threshold is calibrated on that. Re-derive the \
             threshold before accepting this."
        );
        // The evaluator enforces the same scale at runtime -- it rejects any score outside this
        // set. Pin the literal: an added 0 (or a widened set) there is the same regression seen
        // from the code side rather than the rubric side, and it is what would actually let a
        // zero reach the gate.
        assert!(
            EVALUATOR_TS.contains("const VALID_SCORES = new Set([1.0, 0.5, -0.5, -1.0]);"),
            "the vendored evaluator's VALID_SCORES is no longer exactly {{1.0, 0.5, -0.5, -1.0}}. \
             Sparkle's 0.5 gate threshold assumes those four values and no zero; re-derive it \
             before accepting a changed scale."
        );
    }

    #[test]
    fn the_sparkle_patch_to_format_prompt_is_still_applied() {
        // The one delta we carry against upstream, closing TWO hazards in the same call. A naive
        // re-vendor (download upstream, overwrite) reverts both with no other symptom, so assert
        // the marker AND the actual code shape: keeping the comment while reverting the code must
        // not pass.
        //
        // 1. Replacement STRING -> `$&`, `` $` ``, `$'`, `$1`..`$99` are interpreted inside the
        //    payload. We feed this source code and diffs.
        // 2. TWO SEQUENTIAL first-occurrence replaces -> a payload containing the literal
        //    `{message_content}` is spliced in by the first pass and then CAPTURES the second,
        //    relocating the assistant response into the user-prompt section. Payload-controlled.
        assert!(
            EVALUATOR_TS.contains("// SPARKLE PATCH (humanebench-gate)"),
            "the SPARKLE PATCH marker is gone from humanebench_evaluator.ts — the vendored file \
             was overwritten with upstream. Re-apply the formatPrompt single-pass fix."
        );
        let code = strip_line_comments(EVALUATOR_TS);
        // The single pass: ONE alternation over both placeholders. `replace` never re-scans its
        // own replacement output, so inserted payload text cannot be read as a placeholder.
        assert!(
            code.contains("/\\{user_prompt\\}|\\{message_content\\}/g"),
            "formatPrompt no longer substitutes both slots in ONE pass over \
             `/\\{{user_prompt\\}}|\\{{message_content\\}}/g`. Sequential replaces let a payload \
             containing the literal `{{message_content}}` capture the response slot. See \
             resources/humanebench/formatPrompt.test.ts."
        );
        // The replacer FUNCTION: its return value is inserted verbatim, with no `$`-pattern
        // interpretation. Regressing this to a replacement string re-opens hazard 1 even while
        // the single pass above still holds.
        assert!(
            code.contains("(placeholder) => SLOTS[placeholder]"),
            "formatPrompt's replacer is no longer the function `(placeholder) => \
             SLOTS[placeholder]`. A replacement STRING rewrites `$&` / `` $` `` / `$'` / `$1` \
             inside the payload. See resources/humanebench/formatPrompt.test.ts."
        );
        // Upstream's shape, in EITHER of its forms. This catches the replacement-string revert
        // and the two-sequential-passes revert together: both begin with a per-placeholder
        // `.replace('{user_prompt}', …)` call, which the single-pass form does not contain at all.
        assert!(
            !code.contains(".replace('{user_prompt}'"),
            "a per-placeholder `.replace('{{user_prompt}}', …)` call is back in \
             humanebench_evaluator.ts. That is upstream's sequential form — either the payload is \
             being `$`-corrupted again, or a payload containing the literal `{{message_content}}` \
             can capture the response slot."
        );
    }

    #[test]
    fn stripping_comments_is_what_makes_the_patch_scan_meaningful() {
        // Anti-vacuity, both directions, like `the_normalizer_is_what_makes_the_rubric_scan
        // _meaningful` above.
        //
        // 1. The fold genuinely has work to do: the SPARKLE PATCH comment quotes upstream's broken
        //    call shape, so the RAW bytes contain it and a raw negative scan would fail on the
        //    explanation. (This assertion is the one that goes red if that quotation is ever
        //    dropped — at which point the fold is merely unnecessary, not wrong, but the patch
        //    test's negative assertion is no longer testing what its comment says it is.)
        assert!(
            EVALUATOR_TS.contains(".replace('{user_prompt}'"),
            "the SPARKLE PATCH comment no longer quotes upstream's `.replace('{{user_prompt}}', …)` \
             shape. That quotation is what strip_line_comments exists to get out of the way; \
             re-read the_sparkle_patch_to_format_prompt_is_still_applied before trusting it."
        );
        // 2. …and the fold does not eat the code it is meant to leave standing. Without this, a
        //    stripper that returned "" would make every assertion above pass or vanish.
        let code = strip_line_comments(EVALUATOR_TS);
        assert!(
            code.contains("(placeholder) => SLOTS[placeholder]"),
            "the formatPrompt replacer is not in the stripped source. EITHER strip_line_comments \
             ate the code it is meant to leave standing (the patch scan then proves nothing), OR \
             the patch itself was reverted — read \
             the_sparkle_patch_to_format_prompt_is_still_applied first, it says which."
        );
        assert_eq!(strip_line_comments("keep(); // drop"), "keep(); ");
        assert_eq!(strip_line_comments("// all gone"), "");
        assert_eq!(strip_line_comments("no comment here"), "no comment here");
    }

    #[test]
    fn the_normalizer_is_what_makes_the_rubric_scan_meaningful() {
        // Anti-vacuity, both directions (see attention.rs's `the_stripper_is_what_makes_the_scan
        // _meaningful`). The rubric as vendored genuinely NEEDS folding — asserting the raw bytes
        // would pass for the wrong reason — and the normalizer must not be able to manufacture a
        // tier that is not there.
        assert!(
            RUBRIC_V3.contains("\u{2013}1.0") || RUBRIC_V3.contains("\\+1.0"),
            "rubric_v3.md no longer uses the Markdown-escaped / en-dash score forms this \
             normalizer exists to fold. Re-point the guard rather than trusting it."
        );
        assert!(
            !normalize_scale("| tier | meaning |").contains("+1.0"),
            "normalize_scale is inventing score tiers; the rubric scan proves nothing."
        );
        assert!(
            normalize_scale("a 0.0 tier").contains("0.0"),
            "normalize_scale is eating the 0.0 token the zero-tier guard looks for."
        );
    }
}
