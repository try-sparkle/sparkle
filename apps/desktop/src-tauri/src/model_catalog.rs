// Claude model catalog — now a deliberate no-op that always returns an empty list.
//
// It USED to be a BYOK call: GET https://api.anthropic.com/v1/models on the user's own Anthropic
// key, so the per-agent picker could offer models newer than the curated list in
// services/models.ts. That made it the LAST code path in the desktop able to reach an Anthropic API
// key, which is exactly what the migration to the user's Claude Code subscription set out to
// remove — see `list_claude_models` for the full reasoning and
// `no_anthropic_api_key_is_reachable_from_this_crate` for the test that keeps it removed.
//
// The frontend already treats an empty list as "use the curated fallback", so the picker behaves
// exactly as it did for every user who had no key configured — which, after this change, is
// everyone. `ModelInfo` survives because that frontend contract (services/models.ts) still merges
// against this shape.


/// One model as returned to the webview: `{ id, display_name }`. snake_case on purpose — the JS
/// boundary type (services/models.ts) mirrors the Anthropic wire shape.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub display_name: String,
}

/// Always returns an EMPTY list, so the frontend falls back to its curated model list. Kept as a
/// command (rather than deleted outright) because services/models.ts still calls it and merges the
/// result; removing the command would be a separate frontend change with no user-visible gain.
#[tauri::command]
pub async fn list_claude_models() -> Result<Vec<ModelInfo>, String> {
    // ALWAYS EMPTY — and that is the whole point, not a stub.
    //
    // This used to read a BYOK Anthropic key (`ANTHROPIC_API_KEY` / `ANTHROPIC_API`) and GET
    // /v1/models to discover models newer than the curated list. It was the LAST code path in the
    // desktop that could reach an Anthropic API key, and it is removed for two reasons:
    //
    //  1. After the migration to the user's own Claude Code subscription, no user is expected to
    //     hold an Anthropic API key at all — so the dynamic catalog was a feature that, by
    //     construction, could never fire for anyone. On this machine it was actively reaching for
    //     the DEAD key on every load, erroring, and silently falling back.
    //  2. "No code path can reach an Anthropic API key" is now an enforced invariant with a test
    //     (`no_anthropic_api_key_is_reachable_from_this_crate`). This function was the exception
    //     that made that test unwritable.
    //
    // The CLI offers no model-enumeration API to replace it with (there is no `claude models`
    // subcommand — only `--model <alias>` for selection), so the frontend's curated list in
    // services/models.ts is the source of truth. A newly-released model needs one line added there.
    Ok(Vec::new())
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalog_is_empty_so_the_frontend_uses_its_curated_list() {
        // Not a placeholder assertion: an empty list IS the contract now. The BYOK fetch that used
        // to fill it was the last Anthropic-API-key reader in the crate (see the module header), and
        // services/models.ts already treats empty as "use the curated fallback".
        let models = tauri::async_runtime::block_on(list_claude_models()).expect("never errors");
        assert!(models.is_empty());
    }

    #[test]
    fn model_info_serializes_snake_case_for_the_js_boundary() {
        // The frontend contract outlives the fetch: services/models.ts merges against this shape.
        let j = serde_json::to_value(ModelInfo {
            id: "claude-x".into(),
            display_name: "Claude X".into(),
        })
        .expect("serialize");
        assert_eq!(j["id"], "claude-x");
        assert_eq!(j["display_name"], "Claude X");
    }
}
