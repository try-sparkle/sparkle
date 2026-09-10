// oneshot_text — the two pure text operations every cheap-model one-shot needs on its way in and
// on its way out: bound the INPUT so a giant buffer cannot amplify the user's subscription spend,
// and collapse the OUTPUT to one tidy capped line regardless of what the model actually returned.
//
// WHY THIS IS A MODULE AND NOT A COPY. `attention_summary` had both of these as private helpers,
// and `activity_narration` needs exactly the same two with exactly the same semantics. A second
// copy is the shape that drifts: the cap changes on one side, the char-boundary handling is fixed
// on one side, and the two summarizers quietly start disagreeing about what "one line" means with
// nothing red to say so. One copy, one set of tests, both callers delegate.
//
// PURE. Data in, data out — no model call, no I/O, no clock — so the whole policy unit-tests as
// string arithmetic.

/// Take the last `max` CHARS of `s` (never bytes — slicing a multi-byte char panics), trimmed.
///
/// The tail is the half that matters for both callers: a question sits at the END of a terminal
/// screen, and an agent's conclusion about what it just built sits at the END of its turn.
pub(crate) fn tail(s: &str, max: usize) -> String {
    let t = s.trim();
    let n = t.chars().count();
    if n <= max {
        return t.to_string();
    }
    t.chars().skip(n - max).collect::<String>().trim().to_string()
}

/// Collapse internal whitespace runs (incl. newlines) to single spaces, trim, and hard-cap to
/// `cap` chars on a char boundary.
///
/// The cap is a DEFENCE, not a formatting preference: it is what holds when a model ignores the
/// word limit in its prompt, which is the failure this cannot be allowed to pass through — an
/// unbounded string lands in a single-line UI slot and blows out the row it renders in.
pub(crate) fn clean_one_line(s: &str, cap: usize) -> String {
    let collapsed = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= cap {
        return collapsed;
    }
    collapsed.chars().take(cap).collect::<String>().trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_passes_a_short_string_through() {
        assert_eq!(tail("short", 100), "short");
    }

    #[test]
    fn tail_keeps_the_end_and_drops_the_lead() {
        let long = format!("{}HOLD HERE?", "x".repeat(50));
        assert_eq!(tail(&long, 10), "HOLD HERE?");
    }

    #[test]
    fn tail_counts_chars_not_bytes() {
        // Every one of these is 3 bytes and 1 char. A byte-based slice would panic here (or cut a
        // char in half); the char-based one keeps exactly the last three.
        let s = "日本語のテスト"; // 7 chars, 21 bytes
        assert_eq!(s.len(), 21, "precondition: multi-byte, so a byte-slice would be wrong here");
        assert_eq!(tail(s, 3), "テスト");
        assert_eq!(tail(s, 3).chars().count(), 3);
    }

    #[test]
    fn clean_one_line_collapses_whitespace() {
        assert_eq!(clean_one_line("  Want me   to\nhold\there?  ", 100), "Want me to hold here?");
    }

    #[test]
    fn clean_one_line_caps_a_long_line() {
        let long = "word ".repeat(60); // 300 chars before collapse
        assert!(clean_one_line(&long, 100).chars().count() <= 100);
    }

    #[test]
    fn clean_one_line_is_empty_for_whitespace_only() {
        assert_eq!(clean_one_line("   \n\t  ", 100), "");
    }

    #[test]
    fn clean_one_line_caps_on_a_char_boundary() {
        // A cap that lands mid-character must not panic and must not emit a partial char.
        let s = "あ".repeat(50);
        let out = clean_one_line(&s, 10);
        assert_eq!(out.chars().count(), 10);
    }
}
