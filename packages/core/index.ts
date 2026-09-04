export * from "./risk";
export * from "./bridgeRetry";
// The process-level backstop shared by the long-lived stdio MCP servers (mcp-control,
// mcp-orchestrator). Extracted here so the two servers keep ONE definition; each passes its own label.
export * from "./processSafetyNet";
export * from "./historyScope";
export * from "./classifier";
export * from "./analytics";
export * from "./goalGate";
export * from "./goalVerify";
// ── THE PUSHER PIPELINE, IN ORDER — WHICH MODULE OWNS WHICH STAGE ────────────────────────────────
// Every `pusher*.ts` file below carries an excellent header, and each one describes ONLY itself.
// Nothing said which stage it was, so finding the right seam meant reading ~7k lines across the
// whole set. This is that missing index: the stages in the order they run, and the file that owns
// each. Read this to pick a file; read that file's header for why it is the way it is.
//
//   STAGE        OWNER                    WHAT IT TURNS INTO WHAT
//   policy       pusherPolicy.ts          `[pushers]` TOML -> `PusherPolicy`. Clamps the budget
//                                         DOWNWARD only; config may quiet a Pusher, never loosen it.
//   observe      pusherObserve.ts         roster snapshots + prior clocks -> `Observation[]` and the
//                                         next `ObserveState`. Pure; `undefined` means WE DID NOT
//                                         LOOK and never satisfies anything.
//    └ clocks    pusherClocks.ts          the since-when arithmetic `observe` runs on
//                                         (`trackSince`/`elapsedSince`) — durations nothing else in
//                                         the app records.
//   evaluate     pusherTriggers.ts        one `Observation` -> `Trigger[]`, each carrying the numbers
//                                         that made it fire (`evaluateTriggers`).
//   persist      pusherTriggers.ts        two consecutive sightings or it never happened
//                                         (`persistedTriggers`) — the anti-tune-out rule.
//   gate         pusherGate.ts            the ONLY send path: citation rule, `MESSAGES_PER_HOUR`,
//                                         repeat cooldown, inbox yield. Refuses; does not rewrite.
//   decide       pusherDecide.ts          composes evaluate -> persist -> gate for ONE partner in the
//                                         one correct order (`decidePusherAction`), and returns the
//                                         next memory rather than writing it.
//   sweep        pusherFleet.ts           the fleet-wide conditions no partner can act on — quota
//                                         walls, escalations, retirable agents, shared failures,
//                                         conflicting PRs. Reported to the human, not the agent.
//   report       pusherFleetReport.ts     the fleet analogue of `decide` (`decideFleetReport`):
//                                         cooldown per CONDITION, one message per SWEEP.
//   verify       pusherVerify.ts          verify-before-speak. Re-checks each claim against
//                                         git/GitHub at emit time and prunes refuted evidence, because
//                                         the measurement and the sentence are hours apart.
//   re-query     pusherBlocker.ts         when the answer has to come from the agent: the fenced
//                                         `BLOCKER_ASK` grammar, its parser, and the routing table
//                                         saying which party can act on each blocker state.
//
// All of the above is PURE. The impure runner that gathers snapshots, calls `decide`/`report` and
// obeys the answer lives in the desktop app (`services/pusherRunner.ts`, mounted by
// `services/pusherMount.ts`) — no rung of this system may call a model, so nothing here does.
//
// `pusherPipelineMap.test.ts` asserts this table names every `pusher*.ts` module and no ghosts, so a
// new module cannot be added without landing here too.
export * from "./pusherGate";
export * from "./pusherTriggers";
export * from "./pusherPolicy";
export * from "./pusherClocks";
export * from "./pusherObserve";
export * from "./pusherDecide";
export * from "./pusherFleet";
export * from "./pusherFleetReport";
export * from "./pusherVerify";
export * from "./pusherBlocker";
export * from "./babysitDispatch";
// The founder's ask queue — what he asked for, captured by code so a context ending cannot lose it.
// Pure and model-free for the same reason every module above is: a detector for "did you drop
// something" must not share a failure domain with the thing whose reliability is in question.
export * from "./conciergeAsks";
// The peer-messaging cap, shared because the app ENFORCES it and the MCP tool DESCRIBES it.
export * from "./inboxCapacity";
export * from "./peerMessageLimits";
export * from "./stateScopes";
// The research pool's shape, mirrored from `research.rs` and drift-tested against it. Shared
// because the pure deciders pace themselves against the cap and used to restate it in prose,
// where it went stale for six days without anything being able to notice.
export * from "./researchPool";
