import { describe, it, expect, vi } from "vitest";
import { generateVoices } from "./voices";

describe("generateVoices", () => {
  it("keeps well-formed voices, registers each as a Chief skill, drops malformed entries", async () => {
    const plan = {
      voices: [
        {
          name: "Novice Vibe Coder",
          oneLiner: "New to code; judges everything by beginner-friendliness.",
          instructions: "You evaluate everything by whether a beginner could follow it; jargon loses you.",
        },
        {
          name: "Security Hawk",
          oneLiner: "Threat-models everything.",
          instructions: "You probe for auth, input-validation, and data-exposure risks.",
        },
        { name: "  ", oneLiner: "blank name", instructions: "should be dropped" },
        { name: "No Lens", oneLiner: "no instructions", instructions: "" },
      ],
    };
    const structuredJson = async <T>(): Promise<T> => plan as unknown as T;
    const ensured: string[] = [];
    const ensureVoice = vi.fn(async (name: string) => {
      ensured.push(name);
      return name;
    });

    const voices = await generateVoices(
      { structuredJson, ensureVoice },
      {
        corpusSummary: "A coding platform for novice and vibe coders.",
        conversation: "User: I'm building a beginner-friendly coding tool.",
      },
    );

    // Malformed entries (blank name, empty instructions) are dropped.
    expect(voices.map((v) => v.name)).toEqual(["Novice Vibe Coder", "Security Hawk"]);
    // Each kept voice is registered as a Chief persona skill.
    expect(ensured).toEqual(["Novice Vibe Coder", "Security Hawk"]);
  });

  it("caps the slate at `max`", async () => {
    const plan = {
      voices: Array.from({ length: 8 }, (_, i) => ({
        name: `Voice ${i}`,
        oneLiner: "x",
        instructions: "a point-of-view lens",
      })),
    };
    const structuredJson = async <T>(): Promise<T> => plan as unknown as T;
    const ensureVoice = vi.fn(async (n: string) => n);

    const voices = await generateVoices(
      { structuredJson, ensureVoice },
      { corpusSummary: "x", conversation: "y", max: 3 },
    );

    expect(voices).toHaveLength(3);
    expect(ensureVoice).toHaveBeenCalledTimes(3);
  });

  it("returns [] (and registers nothing) when the model yields no voices", async () => {
    const structuredJson = async <T>(): Promise<T> => ({ voices: [] }) as unknown as T;
    const ensureVoice = vi.fn(async (n: string) => n);
    const voices = await generateVoices({ structuredJson, ensureVoice }, { corpusSummary: "x", conversation: "y" });
    expect(voices).toEqual([]);
    expect(ensureVoice).not.toHaveBeenCalled();
  });
});
