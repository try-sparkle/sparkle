// Public surface of the genie intent-routing and response engine (bead sparkle-uz87.5).
//
// THE CONSUMER IS sparkle-uz87.7 — "Wire overlay visual states to voice pipeline events". That task
// owns everything this one deliberately does not: mounting the overlay, driving its `Mode` between
// still/listening/speaking, and deciding what to DO with a `GenieAction`. It should import from
// HERE only; ./classify, ./handlers and ./router are implementation detail, and the rules order
// inside ./classify is expected to keep moving as real transcripts arrive.
//
// The contract it can rely on:
//   • `routeGenieIntent(request, deps?)` always resolves — it never throws and never returns null.
//   • The response carries reply TEXT to paint and, at most, one `GenieAction` to perform.
//   • Nothing here speaks. Text-to-speech was removed from this product (commit f24324e6b); the
//     overlay's `speaking` mode is a VISUAL state, and this module must not be how audio returns.
export { routeGenieIntent, GENIE_CONFIDENCE_FLOOR, GENIE_STALE_MS } from "./router";
export type { GenieRouterDeps } from "./router";
export {
  classifyTranscript,
  normalizeTranscript,
  GENIE_CONFIDENCE_STRONG,
  GENIE_CONFIDENCE_WEAK,
  GENIE_CONFIDENCE_CHAT,
} from "./classify";
export type { GenieClassification, GenieSlots } from "./classify";
export { defaultGenieHandlers, describeGenieAction } from "./handlers";
export type { GenieHandler, GenieHandlerInput, GenieHandlerMap } from "./handlers";
export type {
  GenieAction,
  GenieIntent,
  GenieNavTargetKind,
  GenieRequest,
  GenieResponse,
  GenieScope,
} from "./types";
