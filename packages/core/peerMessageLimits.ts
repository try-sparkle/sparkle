// The one number two packages must agree on for agent-to-agent peer messaging.
//
// WHY IT LIVES HERE rather than beside either user. The cap is ENFORCED in the desktop app
// (`services/controlListener.ts`, which refuses with `too_long`) and DESCRIBED in the MCP server
// (`apps/mcp-control/src/server.ts`, whose tool description tells the whole fleet what the limit
// is). Those are separate packages, so a literal in each is two numbers that look like one — and
// the failure mode is silent: changing the enforcer leaves the tool confidently advertising a cap
// that no longer exists, and every agent that trusted the description gets `too_long` for a message
// it was told was fine.
//
// A test asserting the two literals match would also have worked, and would have been the weaker
// fix: it detects the drift instead of making it unrepresentable. `@sparkle/core` is already the
// home both packages import from (`GOAL_MAX_LEN` is the precedent), so there is one number.

/** Max characters in one peer message. A peer message is coordination ("I am taking the Rust
 *  half"), not a document handoff — say what you need and point at the file, PR or bead. */
export const PEER_MESSAGE_MAX_CHARS = 2000;
