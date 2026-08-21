// The seeding rule, on its own — pure, so the render suite beside it is free to spend its
// assertions on the DOM relationship the founder actually asked about.
import { describe, expect, it } from "vitest";
import { COMPOSE_POST_PROMPT, seedComposePost } from "./composePost";

describe("seedComposePost", () => {
  it("replaces an empty box with the prompt", () => {
    expect(seedComposePost("")).toEqual({
      text: COMPOSE_POST_PROMPT,
      caret: COMPOSE_POST_PROMPT.length,
    });
  });

  it("appends on a new line when a draft is in progress — typing is never destroyed", () => {
    expect(seedComposePost("half a thought").text).toBe(`half a thought\n${COMPOSE_POST_PROMPT}`);
  });

  it("does not double the newline when the draft already ends in one", () => {
    expect(seedComposePost("draft\n").text).toBe(`draft\n${COMPOSE_POST_PROMPT}`);
    expect(seedComposePost("draft\n\n  ").text).toBe(`draft\n${COMPOSE_POST_PROMPT}`);
  });

  it("treats a whitespace-only box as empty rather than appending to nothing", () => {
    // Otherwise a stray space left by a dictation commit produces a leading blank line.
    expect(seedComposePost("   ").text).toBe(COMPOSE_POST_PROMPT);
  });

  it("leaves the caret at the end, so typing continues after the prompt", () => {
    const seeded = seedComposePost("draft");
    expect(seeded.caret).toBe(seeded.text.length);
  });
});
