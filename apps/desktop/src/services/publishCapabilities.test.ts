import { describe, expect, it, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  PUBLISH_AFFORDANCES,
  callDestinationTool,
  hasAffordance,
  listDestinationTools,
  probeDestination,
  type DestinationCapabilities,
} from "./publishCapabilities";

// The webview half of the FROZEN contract with `publish_capabilities.rs`. These tests pin the two
// things a typecheck cannot: the command NAMES (a rename is a runtime-only failure — an
// unregistered or misnamed Tauri command produces no compile error and no warning), and the
// argument key spelling, which Tauri matches by name.

beforeEach(() => {
  invoke.mockReset();
});

/** The exact JSON the Rust side serializes for a destination with the required set and nothing
 *  optional. Written the way serde emits it — camelCase, every key PRESENT — rather than the way a
 *  hand-written optional-field parser would imagine it. */
const REQUIRED_SET_ONLY = {
  valid: true,
  missingRequired: [],
  presentOptional: [],
  missingOptional: [
    "unpublish_content",
    "upload_image",
    "create_video_upload_token",
    "attach_video",
  ],
  argShapeProblems: [],
  affordances: ["project-picker"],
} satisfies DestinationCapabilities;

describe("probeDestination", () => {
  it("invokes destination_probe with the destinationId key Tauri matches on", async () => {
    invoke.mockResolvedValue(REQUIRED_SET_ONLY);

    const caps = await probeDestination("drodio");

    expect(invoke).toHaveBeenCalledWith("destination_probe", { destinationId: "drodio" });
    expect(caps).toEqual(REQUIRED_SET_ONLY);
  });

  it("passes an empty id through, which the host reads as “the active destination”", async () => {
    invoke.mockResolvedValue(REQUIRED_SET_ONLY);

    await probeDestination("");

    expect(invoke).toHaveBeenCalledWith("destination_probe", { destinationId: "" });
  });

  /** The host rejects with a plain string. It must reach the caller as-is: the message is the
   *  destination's own words (already scrubbed of the bearer host-side) and it is what the
   *  configure pane shows. */
  it("surfaces the host's message rather than swallowing it", async () => {
    invoke.mockRejectedValue("there is no publish destination called `nope`");

    await expect(probeDestination("nope")).rejects.toBe(
      "there is no publish destination called `nope`",
    );
  });
});

describe("listDestinationTools / callDestinationTool", () => {
  it("invokes destination_list_tools and returns the total tool shape", async () => {
    invoke.mockResolvedValue([{ name: "create_content", description: "", inputSchema: null }]);

    const tools = await listDestinationTools("drodio");

    expect(invoke).toHaveBeenCalledWith("destination_list_tools", { destinationId: "drodio" });
    const first = tools[0];
    if (!first) throw new Error("the host returned no tools");
    // Every field present — an absent description is "" and an absent schema is null, never
    // undefined. A parser written against `description?: string` would be describing a payload the
    // Rust side cannot produce.
    expect(first.description).toBe("");
    expect(first.inputSchema).toBeNull();
    expect("description" in first).toBe(true);
  });

  it("invokes destination_call_tool with tool and args under their own keys", async () => {
    invoke.mockResolvedValue("ok");

    await callDestinationTool("drodio", "list_projects", { limit: 10 });

    expect(invoke).toHaveBeenCalledWith("destination_call_tool", {
      destinationId: "drodio",
      tool: "list_projects",
      args: { limit: 10 },
    });
  });
});

describe("the affordance key set", () => {
  /** Mirrors `the_affordance_key_set_is_closed` in `publish_capabilities.rs`. Two lists, one
   *  source of truth, and neither compiler can see the other — so both sides pin it. */
  it("is exactly the four keys the host can emit, in the host's order", () => {
    expect(PUBLISH_AFFORDANCES).toEqual([
      "project-picker",
      "image-attach",
      "video-attach",
      "take-down",
    ]);
  });

  it("reports an affordance the destination earned, and not one it did not", () => {
    expect(hasAffordance(REQUIRED_SET_ONLY, "project-picker")).toBe(true);
    expect(hasAffordance(REQUIRED_SET_ONLY, "image-attach")).toBe(false);
  });
});
