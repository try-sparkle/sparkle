//! The publish destination's CAPABILITY PROBE — bead `sparkle-131ms.5`.
//!
//! Sparkle pins a **tool contract, never a site**. A destination is whatever answers `tools/list`
//! with the tools this contract names; drodio.com is the first one, not the definition. So the
//! probe is a pure diff of `tools/list` against a frozen table, and everything the UI is allowed
//! to show is derived from that diff rather than hard-coded against one endpoint.
//!
//! ## Three rules that are easy to get backwards
//!
//! 1. **`list_projects` is REQUIRED**, corrected from the design doc's "optional". `create_content`
//!    demands a `projectId` and has no default, so a destination without `list_projects` exposes a
//!    create call nobody can supply an argument for. Treating it as optional would have shipped a
//!    "valid" destination that cannot create a single draft.
//! 2. **Names are not the contract — argument SHAPES are.** The design calls this "the sharpest
//!    risk": two destinations can both expose `create_content` and mean different things by it. A
//!    destination that exposes the name but does not require `title` and `projectId` is reported as
//!    an argument-shape problem NAMING the tool and the missing property, and is not valid.
//! 3. **Every field crossing to the webview is TOTAL.** A Rust `Option` serializes as `null`, never
//!    as an absent key, and TypeScript's `field?: T` means `T | undefined` — which does not include
//!    `null`. A hand-written parser on the other side would therefore describe a shape this side
//!    cannot produce (see `AGENTS.md`). Making every field non-`Option` removes the trap rather
//!    than documenting it: there is no absent case to model.
//!
//! ## What the probe is NOT
//!
//! It is not an authorization check. A destination can pass this diff and still refuse every call
//! because the token lacks `content:publish` — scopes are not in `tools/list`. `valid` here means
//! "this endpoint speaks the contract", and the credential question is answered by
//! `publish_client`'s decode path at call time.

use serde::Serialize;
use serde_json::Value;

use crate::publish_client::{self, ToolDescriptor};
use crate::publish_credential;
use crate::publish_url;

// ── The frozen contract ───────────────────────────────────────────────────────────────────────

/// Missing ANY of these and the destination is invalid. Ordered as a person would check them:
/// create, then edit, then the public act, then the reads, then the one that supplies `projectId`.
pub const REQUIRED_TOOLS: &[&str] = &[
    "create_content",
    "update_content",
    "publish_content",
    "get_content",
    "list_content",
    // REQUIRED, not optional (correction 2 in the build plan): `create_content` has no default
    // project, so without this there is no way to name one.
    "list_projects",
];

/// Present → an affordance is offered. Absent → that affordance is HIDDEN, and the destination is
/// still perfectly valid. The three media tools do not exist on the reference destination yet
/// (correction 1 in the build plan) — which is exactly why they are the honest test of whether
/// "missing optional hides the affordance" actually works.
pub const OPTIONAL_TOOLS: &[&str] = &[
    "unpublish_content",
    "upload_image",
    "create_video_upload_token",
    "attach_video",
];

/// Tools whose ARGUMENT SHAPE is part of the contract, and the properties each must require.
///
/// Only `create_content` is pinned today, and deliberately: these are the two arguments whose
/// absence means the tool cannot be driven at all (`title` is the post's identity, `projectId` is
/// the one field with no default). Pinning more of the schema would make Sparkle reject
/// destinations that are merely different, which is the opposite of "pin a contract, not a site".
const ARG_SHAPE_CONTRACT: &[(&str, &[&str])] = &[("create_content", &["title", "projectId"])];

// ── Affordance keys (a CLOSED set) ────────────────────────────────────────────────────────────
//
// The UI may render exactly these and nothing else. They are consts rather than string literals
// at the call sites so that the Rust probe and the TypeScript union cannot drift apart silently —
// a test below pins the set, and `publishCapabilities.ts` mirrors it.

/// Pick which project a draft is filed under. Requires `list_projects`.
pub const AFFORDANCE_PROJECT_PICKER: &str = "project-picker";
/// Attach an image to a post. Requires `upload_image`.
pub const AFFORDANCE_IMAGE_ATTACH: &str = "image-attach";
/// Attach a video. Requires BOTH halves of the two-step upload — a token to stream against and the
/// call that binds the result to the post. One without the other is a dead end, so the affordance
/// is offered only when both exist.
pub const AFFORDANCE_VIDEO_ATTACH: &str = "video-attach";
/// Take a live post back down. Requires `unpublish_content`.
pub const AFFORDANCE_TAKE_DOWN: &str = "take-down";

/// Every affordance key, with the tools each one needs. The UI iterates this; nothing hand-lists.
const AFFORDANCES: &[(&str, &[&str])] = &[
    (AFFORDANCE_PROJECT_PICKER, &["list_projects"]),
    (AFFORDANCE_IMAGE_ATTACH, &["upload_image"]),
    (
        AFFORDANCE_VIDEO_ATTACH,
        &["create_video_upload_token", "attach_video"],
    ),
    (AFFORDANCE_TAKE_DOWN, &["unpublish_content"]),
];

// ── The wire shapes ───────────────────────────────────────────────────────────────────────────

/// What a destination can do, as the webview sees it.
///
/// **Every field is total.** No `Option`, anywhere — see rule 3 in the module header. `valid`
/// carries the verdict so the UI never has to re-derive it from two emptiness checks and get the
/// conjunction wrong.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DestinationCapabilities {
    /// True only when nothing required is missing AND no required tool's arguments are wrong.
    /// Both, because a `create_content` that does not take a `projectId` is present-but-unusable,
    /// and reporting that destination as valid would send the user to a create call that cannot
    /// succeed.
    pub valid: bool,
    /// Required tools the destination does not expose. Empty when `valid`.
    pub missing_required: Vec<String>,
    /// Optional tools it does expose.
    pub present_optional: Vec<String>,
    /// Optional tools it does not. Not an error — each one hides an affordance.
    pub missing_optional: Vec<String>,
    /// Human-readable, one per problem, each NAMING the tool and the missing property. Rendered
    /// verbatim: a destination's schema is the destination's business, and a paraphrase would cost
    /// the one detail that makes the message actionable.
    pub arg_shape_problems: Vec<String>,
    /// The affordance keys the UI may show. **Empty when `!valid`** — an invalid destination gets
    /// no controls at all, because an "attach image" button on a destination that cannot create a
    /// post is an invitation to a failure the probe already saw coming.
    pub affordances: Vec<String>,
}

/// One tool as the destination declared it, for the configure pane's tool list.
///
/// Total, like [`DestinationCapabilities`]: an absent description is `""` and an absent schema is
/// `Value::Null`, so the TypeScript side never models `undefined`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptorDto {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

impl From<&ToolDescriptor> for ToolDescriptorDto {
    fn from(t: &ToolDescriptor) -> Self {
        Self {
            name: t.name.clone(),
            description: t.description.clone(),
            input_schema: t.input_schema.clone(),
        }
    }
}

// ── The pure diff ─────────────────────────────────────────────────────────────────────────────

/// Diff a destination's advertised tool set against the frozen contract.
///
/// Pure and total: no network, no config, no clock. Everything the probe command reports is this
/// function's answer, so the whole verdict is unit-testable against a hand-built tool list.
pub fn diff_contract(tools: &[ToolDescriptor]) -> DestinationCapabilities {
    let has = |name: &str| tools.iter().any(|t| t.name == name);

    let missing_required: Vec<String> = REQUIRED_TOOLS
        .iter()
        .filter(|n| !has(n))
        .map(|n| (*n).to_string())
        .collect();

    let (present_optional, missing_optional): (Vec<String>, Vec<String>) = {
        let mut present = Vec::new();
        let mut missing = Vec::new();
        for n in OPTIONAL_TOOLS {
            if has(n) {
                present.push((*n).to_string());
            } else {
                missing.push((*n).to_string());
            }
        }
        (present, missing)
    };

    let arg_shape_problems = arg_shape_problems(tools);

    let valid = missing_required.is_empty() && arg_shape_problems.is_empty();

    // Derived from the tools, then GATED on validity. Deriving first and gating second (rather
    // than early-returning) keeps the two decisions separate: which affordances the tools support
    // is a fact about the destination, and whether the user may see any of them is a policy.
    let affordances = if valid {
        AFFORDANCES
            .iter()
            .filter(|(_, needs)| needs.iter().all(|n| has(n)))
            .map(|(key, _)| (*key).to_string())
            .collect()
    } else {
        Vec::new()
    };

    DestinationCapabilities {
        valid,
        missing_required,
        present_optional,
        missing_optional,
        arg_shape_problems,
        affordances,
    }
}

/// Argument-shape problems, one message per missing property.
///
/// A tool the destination does not expose at all produces NO problem here — that is already
/// reported as a missing required tool, and saying it twice in two different vocabularies would
/// make the pane read as if two separate things were wrong.
fn arg_shape_problems(tools: &[ToolDescriptor]) -> Vec<String> {
    let mut out = Vec::new();
    for (tool_name, needed) in ARG_SHAPE_CONTRACT {
        let Some(tool) = tools.iter().find(|t| &t.name == tool_name) else {
            continue;
        };
        for prop in *needed {
            if !tool.required_args.iter().any(|a| a == prop) {
                out.push(format!(
                    "`{tool_name}` does not require `{prop}` — Sparkle sends it on every call, and \
                     a destination that does not ask for it means something different by \
                     `{tool_name}` than Sparkle does"
                ));
            }
        }
    }
    out
}

// ── Resolving a destination (config + keychain + URL re-validation) ───────────────────────────

/// A destination's endpoint and bearer, resolved and re-validated at CALL time.
struct Resolved {
    url: String,
    token: String,
}

/// Resolve a configured destination id to the URL and token a call needs.
///
/// **The URL is re-validated here**, not only where it was configured. `config.toml` is a file on
/// disk that a human edits; validating only in the configure pane means a hand-edited `http://`
/// destination routes around every rule the pane enforces. `publish_url::validate_destination_url`
/// is the one definition, called at both moments.
///
/// An empty `destination_id` means "whichever destination is active", which is what the configure
/// pane wants before it has an id in hand.
fn resolve(destination_id: &str) -> Result<Resolved, String> {
    let cfg = crate::config::current_effective().config.publish;

    let id = if destination_id.trim().is_empty() {
        cfg.active.clone().ok_or_else(|| {
            "no publish destination is active — configure one in Settings › Publishing".to_string()
        })?
    } else {
        destination_id.to_string()
    };

    let dest = cfg.destinations.get(&id).ok_or_else(|| {
        format!("there is no publish destination called `{id}` in your configuration")
    })?;

    // Re-validated, deliberately. See the doc comment.
    validate_url_at_call_time(&dest.url)?;

    let token = publish_credential::token_for_destination(&id).ok_or_else(|| {
        format!(
            "no credential is stored for `{id}` — paste its token in Settings › Publishing before \
             probing it"
        )
    })?;

    Ok(Resolved {
        url: dest.url.clone(),
        token,
    })
}

/// The call-time URL gate, split out so a test can drive it without a config file or a keychain.
///
/// Returns the message unchanged from `publish_url`, prefixed with the fact that this is the
/// STORED value rather than something the user just typed — the remedy is an edit to `config.toml`
/// or the configure pane, and a message that reads like input validation sends them looking for a
/// field they are not currently in front of.
fn validate_url_at_call_time(raw: &str) -> Result<(), String> {
    publish_url::validate_destination_url(raw)
        .map(|_| ())
        .map_err(|e| format!("that destination's configured URL is not usable: {e}"))
}

/// Strip a secret out of anything on its way to the webview.
///
/// This is not belt-and-braces. Destinations really do echo request headers back in error bodies —
/// a debug-mode 500, a WAF page quoting what it blocked — and `publish_client` surfaces a
/// destination's own words verbatim on the `Tool` and `Protocol` paths, which is the right call for
/// every other reason. So the scrub happens at the boundary that matters: the last point before a
/// string leaves Rust.
///
/// An empty needle returns the message untouched. Splicing a marker between every character of a
/// message because the token happened to be empty would be a worse outcome than the one it guards.
fn scrub_secret(message: &str, secret: &str) -> String {
    if secret.is_empty() {
        return message.to_string();
    }
    message.replace(secret, "<redacted>")
}

// ── Tauri commands ────────────────────────────────────────────────────────────────────────────
//
// All three are `pub async fn` with the network call inside `spawn_blocking`. A synchronous
// `#[tauri::command]` body runs on the main thread, freezes the UI and starves the concierge
// bridge — a repeated failure shape in this app. Being async is also why none of them needs a
// `cmd_timing.rs` EXEMPT entry.
//
// `tauri::async_runtime::spawn_blocking` IS tokio's, re-exported; `tokio` is not a declared
// dependency of this crate, and `publish_credential.rs` next door already uses this spelling.

/// What the join handle failing means. Same wording as `publish_credential`'s: a task that did not
/// finish is not a destination that answered, and the two must never be confused.
const JOIN_FAILED: &str = "the probe task didn't finish";

/// Probe a destination and diff what it advertises against the contract.
///
/// The read-only half of configuring a destination: it calls `tools/list` and nothing else, so it
/// is safe to run on every render of the configure pane.
#[tauri::command]
pub async fn destination_probe(destination_id: String) -> Result<DestinationCapabilities, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let d = resolve(&destination_id)?;
        let tools = publish_client::list_tools(&d.url, &d.token)
            .map_err(|e| scrub_secret(e.message(), &d.token))?;
        Ok(diff_contract(&tools))
    })
    .await
    .unwrap_or_else(|_| Err(JOIN_FAILED.to_string()))
}

/// The destination's tool list, verbatim, for the configure pane's detail view.
///
/// Separate from [`destination_probe`] because they answer different questions: the probe says
/// whether Sparkle can use this destination, and this says what the destination claims it is. A
/// pane that shows only the verdict cannot help someone whose destination is *almost* right.
#[tauri::command]
pub async fn destination_list_tools(
    destination_id: String,
) -> Result<Vec<ToolDescriptorDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let d = resolve(&destination_id)?;
        let tools = publish_client::list_tools(&d.url, &d.token)
            .map_err(|e| scrub_secret(e.message(), &d.token))?;
        Ok(tools.iter().map(ToolDescriptorDto::from).collect())
    })
    .await
    .unwrap_or_else(|_| Err(JOIN_FAILED.to_string()))
}

/// Call one of the destination's tools and return its text answer.
///
/// Is this a tool name Sparkle's pinned contract knows about?
///
/// The RISK gate — which of these may be called, and which need an approval card — is the concierge
/// policy layer's job (`sparkle-131ms.6`), and this is deliberately not a second copy of it. This
/// is the narrower question of whether the name is in the contract at all, and it exists because
/// the parameter is a free `String` arriving from the webview: without it this command forwards
/// ANY name to the destination with the bearer attached (roborev 66504, Medium).
///
/// Defence in depth, not the gate. Sparkle only ever calls contract tools, so the check costs
/// nothing it legitimately does, and it means a bug elsewhere cannot turn this into a general
/// authenticated proxy to the destination.
fn is_contract_tool(tool: &str) -> bool {
    REQUIRED_TOOLS.contains(&tool) || OPTIONAL_TOOLS.contains(&tool)
}

/// The gate on WHICH tools may be called this way — and which need an approval card — is the
/// concierge policy layer (`sparkle-131ms.6`), not this command: it is the transport. What this
/// command does enforce is that the name is in the pinned contract at all; see
/// [`is_contract_tool`]. A failed tool is an `Err`, including the HTTP-200-with-`isError` shape
/// that `publish_client`'s decoder exists to catch.
#[tauri::command]
pub async fn destination_call_tool(
    destination_id: String,
    tool: String,
    args: Value,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_contract_tool(&tool) {
            // Named, so a destination author adding a tool Sparkle has not pinned gets a message
            // they can act on rather than a silent nothing.
            return Err(format!(
                "`{tool}` is not part of the publish contract Sparkle pins, so it will not be \
                 called. If a destination has grown a tool Sparkle should use, it has to be added \
                 to the contract (and to docs/publish-destinations.md) first."
            ));
        }
        let d = resolve(&destination_id)?;
        publish_client::call_tool(&d.url, &d.token, &tool, args)
            .map_err(|e| scrub_secret(e.message(), &d.token))
    })
    .await
    .unwrap_or_else(|_| Err(JOIN_FAILED.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// THE COMMAND ITSELF REFUSES, not merely the predicate beside it (roborev 66549, Medium).
    ///
    /// The predicate test below is the both-directions half, and on its own it is not enough:
    /// delete the `if !is_contract_tool(&tool)` block from `destination_call_tool` — the entire
    /// defect — and it stays green, because nothing exercises the call site. Its own heading
    /// claims a refusal "BEFORE ANY NETWORK CALL", which is a statement about the COMMAND.
    ///
    /// The id here names no configured destination, so if the guard were removed this would fail
    /// at `resolve()` with a different message instead. Asserting the error names the TOOL is what
    /// distinguishes "refused for the right reason, before any config/keychain/network was
    /// touched" from "fell through and failed later".
    #[test]
    fn the_command_refuses_a_tool_outside_the_contract_before_resolving_anything() {
        let err = tauri::async_runtime::block_on(destination_call_tool(
            "no-such-destination".to_string(),
            "delete_everything".to_string(),
            json!({}),
        ))
        .expect_err("a tool outside the pinned contract must never be forwarded");

        assert!(
            err.contains("delete_everything"),
            "the refusal must NAME the tool so a destination author can act on it: {err}"
        );
        assert!(
            err.contains("publish contract"),
            "and must say why it was refused, not fail later at resolve(): {err}"
        );
    }

    /// AN ARBITRARY TOOL NAME IS REFUSED BEFORE ANY NETWORK CALL (roborev 66504, Medium).
    ///
    /// `tool` is a free `String` from the webview. Without this, the command is an authenticated
    /// proxy that forwards any name to the destination with the bearer attached. Asserted on the
    /// PREDICATE the command consults, and in BOTH directions — a check that refused everything
    /// would satisfy "arbitrary names are refused" while breaking every real call.
    #[test]
    fn only_contract_tool_names_are_callable() {
        for allowed in REQUIRED_TOOLS.iter().chain(OPTIONAL_TOOLS.iter()) {
            assert!(
                is_contract_tool(allowed),
                "{allowed} is in the pinned contract and must be callable"
            );
        }
        for denied in [
            "",
            "delete_everything",
            "publish_content ",   // trailing space — near-miss, not a match
            "PUBLISH_CONTENT",    // case matters; the wire names are lowercase
            "../../etc/passwd",
        ] {
            assert!(
                !is_contract_tool(denied),
                "{denied:?} is not in the contract and must not reach the destination"
            );
        }
    }
    use crate::publish_client::PublishError;
    use serde_json::json;

    /// Build a tool the way a destination would declare it, so a test never hand-writes the
    /// flattening the decoder does.
    fn tool(name: &str, required: &[&str]) -> ToolDescriptor {
        ToolDescriptor {
            name: name.to_string(),
            description: format!("{name} description"),
            required_args: required.iter().map(|s| (*s).to_string()).collect(),
            input_schema: json!({
                "type": "object",
                "required": required,
                "properties": required.iter().map(|r| (r.to_string(), json!({"type": "string"})))
                    .collect::<serde_json::Map<_, _>>(),
            }),
        }
    }

    /// Every required tool, each with an argument shape the contract accepts. The baseline the
    /// tests below subtract from — subtracting is what makes each assertion about one thing.
    fn full_required() -> Vec<ToolDescriptor> {
        vec![
            tool("create_content", &["title", "projectId"]),
            tool("update_content", &["id"]),
            tool("publish_content", &["id"]),
            tool("get_content", &["id"]),
            tool("list_content", &[]),
            tool("list_projects", &[]),
        ]
    }

    #[test]
    fn a_destination_exposing_only_create_content_is_invalid_and_names_what_is_missing() {
        let caps = diff_contract(&[tool("create_content", &["title", "projectId"])]);

        assert!(!caps.valid, "five required tools are absent");
        // Named, not counted: "5 tools missing" tells the user nothing they can act on.
        assert_eq!(
            caps.missing_required,
            vec![
                "update_content",
                "publish_content",
                "get_content",
                "list_content",
                "list_projects",
            ],
        );
        assert!(
            caps.affordances.is_empty(),
            "an invalid destination offers no controls at all"
        );
    }

    /// The correction the build plan makes to the design doc, asserted rather than commented:
    /// `list_projects` is REQUIRED. If it were optional, this destination would read as valid.
    #[test]
    fn a_destination_without_list_projects_is_invalid() {
        let tools: Vec<_> = full_required()
            .into_iter()
            .filter(|t| t.name != "list_projects")
            .collect();

        let caps = diff_contract(&tools);

        assert!(!caps.valid);
        assert_eq!(caps.missing_required, vec!["list_projects"]);
        assert!(
            !caps.missing_optional.contains(&"list_projects".to_string()),
            "list_projects must not appear on the optional side as well"
        );
    }

    #[test]
    fn the_required_set_alone_is_valid_and_media_affordances_stay_hidden() {
        let caps = diff_contract(&full_required());

        assert!(caps.valid, "{:?}", caps);
        assert!(caps.missing_required.is_empty());
        assert!(caps.arg_shape_problems.is_empty());

        // The one affordance the required set earns.
        assert_eq!(caps.affordances, vec![AFFORDANCE_PROJECT_PICKER]);

        // And the ones it does not — asserted by NAME, because "only one affordance" would still
        // pass if the wrong one were the survivor.
        for hidden in [
            AFFORDANCE_IMAGE_ATTACH,
            AFFORDANCE_VIDEO_ATTACH,
            AFFORDANCE_TAKE_DOWN,
        ] {
            assert!(
                !caps.affordances.iter().any(|a| a == hidden),
                "{hidden} must be hidden when its tool is absent"
            );
        }
        assert_eq!(
            caps.missing_optional,
            vec![
                "unpublish_content",
                "upload_image",
                "create_video_upload_token",
                "attach_video",
            ],
        );
    }

    #[test]
    fn each_optional_tool_unlocks_exactly_its_own_affordance() {
        let mut tools = full_required();
        tools.push(tool("upload_image", &["data"]));
        let caps = diff_contract(&tools);
        assert!(caps.affordances.iter().any(|a| a == AFFORDANCE_IMAGE_ATTACH));
        assert!(
            !caps.affordances.iter().any(|a| a == AFFORDANCE_TAKE_DOWN),
            "upload_image must not unlock take-down"
        );
        assert_eq!(caps.present_optional, vec!["upload_image"]);

        let mut tools = full_required();
        tools.push(tool("unpublish_content", &["id"]));
        let caps = diff_contract(&tools);
        assert!(caps.affordances.iter().any(|a| a == AFFORDANCE_TAKE_DOWN));
        assert!(
            !caps.affordances.iter().any(|a| a == AFFORDANCE_IMAGE_ATTACH),
            "unpublish_content must not unlock image-attach"
        );
    }

    /// Video takes TWO tools. Either half alone is a dead end — a token with nothing to bind it to,
    /// or a bind call with no way to get the bytes there — so the affordance must not appear.
    #[test]
    fn video_attach_needs_both_halves() {
        let mut only_token = full_required();
        only_token.push(tool("create_video_upload_token", &[]));
        assert!(
            !diff_contract(&only_token)
                .affordances
                .iter()
                .any(|a| a == AFFORDANCE_VIDEO_ATTACH),
            "a token with nothing to attach is not a video affordance"
        );

        let mut only_attach = full_required();
        only_attach.push(tool("attach_video", &["id", "url"]));
        assert!(
            !diff_contract(&only_attach)
                .affordances
                .iter()
                .any(|a| a == AFFORDANCE_VIDEO_ATTACH),
            "an attach call with no way to upload is not a video affordance"
        );

        let mut both = full_required();
        both.push(tool("create_video_upload_token", &[]));
        both.push(tool("attach_video", &["id", "url"]));
        assert!(both_have_video(&both));
    }

    fn both_have_video(tools: &[ToolDescriptor]) -> bool {
        diff_contract(tools)
            .affordances
            .iter()
            .any(|a| a == AFFORDANCE_VIDEO_ATTACH)
    }

    /// The sharpest risk in the design: the NAME is present and the destination still means
    /// something else by it.
    #[test]
    fn create_content_without_project_id_is_an_arg_shape_problem_naming_the_property() {
        let mut tools = full_required();
        tools.retain(|t| t.name != "create_content");
        tools.push(tool("create_content", &["title"])); // no projectId

        let caps = diff_contract(&tools);

        assert!(
            caps.missing_required.is_empty(),
            "the tool IS present — this must not be reported as a missing tool"
        );
        assert_eq!(caps.arg_shape_problems.len(), 1);
        let problem = &caps.arg_shape_problems[0];
        assert!(problem.contains("create_content"), "{problem}");
        assert!(problem.contains("projectId"), "{problem}");
        assert!(
            !caps.valid,
            "a create_content that cannot be given a project is not a usable destination"
        );
        assert!(
            caps.affordances.is_empty(),
            "an arg-shape failure hides the controls exactly like a missing tool does"
        );
    }

    #[test]
    fn a_create_content_missing_both_properties_reports_both() {
        let mut tools = full_required();
        tools.retain(|t| t.name != "create_content");
        tools.push(tool("create_content", &[]));

        let caps = diff_contract(&tools);

        assert_eq!(caps.arg_shape_problems.len(), 2, "{:?}", caps);
        assert!(caps.arg_shape_problems.iter().any(|p| p.contains("title")));
        assert!(caps
            .arg_shape_problems
            .iter()
            .any(|p| p.contains("projectId")));
    }

    /// A tool that is absent entirely is reported ONCE, as a missing tool — not a second time in
    /// argument-shape vocabulary, which would read as two separate faults.
    #[test]
    fn an_absent_create_content_is_not_also_an_arg_shape_problem() {
        let tools: Vec<_> = full_required()
            .into_iter()
            .filter(|t| t.name != "create_content")
            .collect();

        let caps = diff_contract(&tools);

        assert_eq!(caps.missing_required, vec!["create_content"]);
        assert!(caps.arg_shape_problems.is_empty(), "{:?}", caps);
    }

    /// The closed set, pinned. A key added here without a matching entry in
    /// `publishCapabilities.ts`'s union is a drift the TypeScript side cannot see.
    #[test]
    fn the_affordance_key_set_is_closed() {
        let keys: Vec<&str> = AFFORDANCES.iter().map(|(k, _)| *k).collect();
        assert_eq!(
            keys,
            vec!["project-picker", "image-attach", "video-attach", "take-down"],
        );
    }

    /// The wire shape the TypeScript side is written against. camelCase, and every key PRESENT —
    /// a serialized `DestinationCapabilities` must never be missing a field, because that is the
    /// shape a `field?: T` parser on the other side would be modelling and this side cannot send.
    #[test]
    fn the_serialized_shape_is_camel_case_and_total() {
        let v = serde_json::to_value(diff_contract(&full_required())).expect("serializes");
        let obj = v.as_object().expect("an object");

        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "affordances",
                "argShapeProblems",
                "missingOptional",
                "missingRequired",
                "presentOptional",
                "valid",
            ],
        );
        for k in &keys {
            assert!(!obj[*k].is_null(), "{k} must never serialize as null");
        }
    }

    #[test]
    fn a_tool_descriptor_dto_is_camel_case_and_carries_the_whole_schema() {
        let dto = ToolDescriptorDto::from(&tool("create_content", &["title", "projectId"]));
        let v = serde_json::to_value(&dto).expect("serializes");

        assert_eq!(v["name"], json!("create_content"));
        assert_eq!(v["description"], json!("create_content description"));
        // The whole schema, not a reconstruction: `properties` is present, which a
        // `{"required": [...]}` stand-in would have lost.
        assert_eq!(v["inputSchema"]["properties"]["title"]["type"], json!("string"));
        assert!(v.get("input_schema").is_none(), "snake_case must not leak");
    }

    /// A destination that declares no `inputSchema` at all still produces a total DTO: `null`,
    /// never an absent key.
    #[test]
    fn an_absent_input_schema_serializes_as_null_not_as_a_missing_key() {
        let dto = ToolDescriptorDto::from(&ToolDescriptor {
            name: "list_content".to_string(),
            description: String::new(),
            required_args: vec![],
            input_schema: Value::Null,
        });
        let v = serde_json::to_value(&dto).expect("serializes");
        assert!(
            v.as_object().expect("object").contains_key("inputSchema"),
            "the key must be present even when the schema is not"
        );
        assert_eq!(v["inputSchema"], Value::Null);
        assert_eq!(v["description"], json!(""));
    }

    /// The decoder really does carry the schema through — asserted against a raw `tools/list` body
    /// rather than a hand-built `ToolDescriptor`, so this fails if the flattening ever drops it.
    #[test]
    fn the_decoder_carries_the_declared_schema_into_the_dto() {
        let body = r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[
            {"name":"create_content","description":"d","inputSchema":
             {"type":"object","required":["title","projectId"],
              "properties":{"title":{"type":"string"},"projectId":{"type":"string"}}}}]}}"#;

        let tools = publish_client::decode_tools_list(body).expect("decodes");
        let dto = ToolDescriptorDto::from(&tools[0]);

        assert_eq!(
            dto.input_schema["properties"]["projectId"]["type"],
            json!("string")
        );
        assert!(
            diff_contract(&tools).arg_shape_problems.is_empty(),
            "the schema the decoder produced satisfies the arg-shape contract"
        );
    }

    // ── The credential must not cross the boundary ────────────────────────────────────────────

    /// A destination that echoes the `Authorization` header back in an error body — a debug 500, a
    /// WAF page quoting what it blocked — must not hand that bearer to the webview. The client
    /// surfaces a destination's own words verbatim, correctly; the scrub is the last gate before
    /// the string leaves Rust.
    #[test]
    fn a_bearer_echoed_back_by_the_destination_is_scrubbed_before_the_webview_sees_it() {
        let token = "sk-live-abc123DEADBEEF";
        let echoed = PublishError::Protocol(format!(
            "upstream rejected request with headers: authorization: Bearer {token}"
        ));

        let out = scrub_secret(echoed.message(), token);

        assert!(!out.contains(token), "the bearer leaked: {out}");
        assert!(out.contains("<redacted>"));
        // The rest of the message survives — a scrub that ate the diagnostic would trade one
        // failure for another.
        assert!(out.contains("upstream rejected request"));
    }

    /// An empty needle must return the message untouched. `String::replace` with an empty pattern
    /// splices the replacement between every character, which would turn a readable error into
    /// noise precisely when there is no secret to protect.
    #[test]
    fn scrubbing_with_no_secret_leaves_the_message_alone() {
        assert_eq!(scrub_secret("plain message", ""), "plain message");
    }

    /// The call-time URL gate. A hand-edited `config.toml` is the threat: the configure pane's
    /// validation is not in the path when the file is edited directly, so the same rule runs again
    /// here — and its message must not read as if the user were typing into a field.
    #[test]
    fn a_hand_edited_plaintext_url_is_refused_at_call_time() {
        let err = validate_url_at_call_time("http://drodio.com/api/mcp")
            .expect_err("plain http to a remote host must be refused");
        assert!(err.contains("configured URL"), "{err}");
        assert!(err.contains("https"), "{err}");

        validate_url_at_call_time("https://drodio.com/api/mcp").expect("https is fine");
        validate_url_at_call_time("http://localhost:3000/api/mcp")
            .expect("loopback development is exempt");
    }

    #[test]
    fn a_url_carrying_userinfo_is_refused_at_call_time() {
        assert!(validate_url_at_call_time("https://user:pw@drodio.com/api/mcp").is_err());
    }
}
