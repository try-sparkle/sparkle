// One handler per intent, plus the exhaustive `switch` that ties the action union to its copy.
// Bead sparkle-uz87.5.
//
// WHY A MAP AND NOT A `switch` IN THE ROUTER. `GenieHandlerMap` is `Record<GenieIntent, GenieHandler>`,
// so adding an intent to the union makes every construction of a map a compile error until the new
// handler exists. That is the same tie `describeGenieAction` makes for `GenieAction`, on the other
// axis. A map also lets router tests substitute a fake handler and assert it RAN with the right
// classification, which is the only way to check routing without asserting on copy.
//
// THE HAZARD THAT COMES WITH THAT, and it is the one this repo keeps paying for: when EVERY test
// injects its own map, the line supplying the real one is covered by nothing. Delete
// `defaultGenieHandlers` from the router's fallback and a fully-injected suite stays green while
// the shipped feature routes to nothing. So `router.realHandlers.test.ts` calls `routeGenieIntent`
// with NO handler map at all, for every one of the seven intents, and asserts the real handler's
// own action payload and copy.
import type {
  GenieAction,
  GenieIntent,
  GenieNavTargetKind,
  GenieRequest,
  GenieResponse,
  GenieScope,
} from "./types";
import type { GenieClassification } from "./classify";

/** Everything a handler is given. Handlers are pure: no stores, no IPC, no clock of their own. */
export interface GenieHandlerInput {
  request: GenieRequest;
  classification: GenieClassification;
  /** The router's injected clock, already read. Handlers never call `Date.now()` themselves. */
  at: number;
}

export type GenieHandler = (input: GenieHandlerInput) => GenieResponse | Promise<GenieResponse>;

/** Every intent must have a handler. The compiler enforces it — see the header. */
export type GenieHandlerMap = Record<GenieIntent, GenieHandler>;

/**
 * The action -> user-visible sentence map, and the ONLY exhaustive tie between `GenieAction` and
 * code that must keep up with it. Add a variant to the union without adding a case here and
 * `const _exhaustive: never = action` fails `tsc --noEmit`. That is a real tie; a runtime test that
 * counts variants is not, because TypeScript unions do not exist at runtime.
 *
 * SHOWN, NEVER SPOKEN. Everything this returns is painted in the overlay's text bubble.
 */
function describeNavigation(kind: GenieNavTargetKind, target: string): string {
  switch (kind) {
    case "screen":
      return `Opening the ${target} screen.`;
    case "agent":
      return `Opening agent ${target}.`;
    case "project":
      return `Opening the ${target} project.`;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function describeGenieAction(action: GenieAction): string {
  switch (action.kind) {
    case "search":
      return `Searching for "${action.query}".`;
    case "remind":
      return action.whenText
        ? `I'll remind you to ${action.what} — ${action.whenText}.`
        : `I'll remind you to ${action.what}.`;
    case "summarize":
      return `Pulling together a summary of ${action.subject}.`;
    case "navigate":
      return describeNavigation(action.targetKind, action.target);
    case "dispatch-start":
      return `Starting an agent on ${action.brief}.`;
    case "dispatch-message":
      return `Passing that to ${action.agent}: "${action.message}".`;
    case "status":
      return action.target
        ? `Checking what ${action.target} is up to.`
        : `Checking what the ${action.scope} is up to.`;
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

/** Build a response around an action, deriving its copy from the one description switch. */
function acted(
  intent: GenieIntent,
  classification: GenieClassification,
  action: GenieAction,
): GenieResponse {
  return {
    intent,
    replyText: describeGenieAction(action),
    confidence: classification.confidence,
    action,
  };
}

export const searchHandler: GenieHandler = ({ classification }) =>
  acted("search", classification, {
    kind: "search",
    query: classification.slots.query ?? "",
  });

export const remindHandler: GenieHandler = ({ classification }) =>
  acted("remind", classification, {
    kind: "remind",
    what: classification.slots.what ?? "",
    // `null`, not `undefined`: "the user named no time" is a value the consumer must handle, not an
    // absent field it can forget about.
    whenText: classification.slots.whenText ?? null,
  });

export const summarizeHandler: GenieHandler = ({ classification }) =>
  acted("summarize", classification, {
    kind: "summarize",
    subject: classification.slots.subject ?? "",
    scope: classification.slots.scope ?? "unspecified",
  });

export const navigateHandler: GenieHandler = ({ classification }) =>
  acted("navigate", classification, {
    kind: "navigate",
    targetKind: classification.slots.targetKind ?? "project",
    target: classification.slots.target ?? "",
  });

/**
 * The one handler that picks between two action kinds. Messaging an existing agent and starting a
 * new one are different enough that the union splits them; the classifier already decided which by
 * filling `mode`, and a missing `mode` falls to `start` (nothing to name means nothing to message).
 */
export const dispatchHandler: GenieHandler = ({ classification }) => {
  const { mode, agent, message, brief } = classification.slots;
  if (mode === "message" && agent) {
    return acted("dispatch", classification, {
      kind: "dispatch-message",
      agent,
      message: message ?? "",
    });
  }
  return acted("dispatch", classification, { kind: "dispatch-start", brief: brief ?? "" });
};

export const statusHandler: GenieHandler = ({ classification }) => {
  const target = classification.slots.target ?? "";
  const scope: GenieScope = classification.slots.scope ?? "fleet";
  return acted("status", classification, {
    kind: "status",
    scope,
    target: target || null,
  });
};

/**
 * The fallback. It carries NO action, and that is the whole design: an utterance the genie did not
 * understand must never move anything. It echoes what was heard so a misheard word is obvious to
 * the user without them having to guess what went wrong.
 */
export const chatHandler: GenieHandler = ({ request, classification }) => {
  const heard = request.transcript.trim();
  return {
    intent: "chat",
    replyText: heard
      ? `I heard "${heard}" — I don't have an action for that yet. Say it another way and I'll try again.`
      : "I didn't catch that. Say it again?",
    confidence: classification.confidence,
  };
};

/** The REAL map. `router.realHandlers.test.ts` exercises this object, not a fake. */
export const defaultGenieHandlers: GenieHandlerMap = {
  search: searchHandler,
  remind: remindHandler,
  summarize: summarizeHandler,
  navigate: navigateHandler,
  dispatch: dispatchHandler,
  status: statusHandler,
  chat: chatHandler,
};
