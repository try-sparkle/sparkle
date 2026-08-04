// The plain-Claude-Code half of the thinking indicator's vocabulary. Pure — no DOM, no store.
//
// The property under test is HONESTY, the same one conciergeActivityLine.test.ts asserts: the line
// must report the tool that ACTUALLY RAN, in the tense the observation supports, must decline rather
// than invent, and must never carry a path, a secret or a raw command into a 360px shared column.
//
// Every assertion here is on the RETURNED PHRASE. An assertion that the table contains an entry
// would be true before the entry was ever wired to the function — the vacuous-test shape AGENTS.md
// names as the #1 fleet-wide finding.
import { describe, expect, it } from "vitest";

import {
  BASH_RULES,
  CONCIERGE_NATIVE_TOOL_LINES,
  conciergeNativeToolLine,
  type ConciergeNativeLine,
} from "./conciergeNativeToolLine";

/** A `Bash` call whose command is exactly `command`. */
function bash(command: string): ConciergeNativeLine | null {
  return conciergeNativeToolLine({ name: "Bash", input: JSON.stringify({ command }) });
}

function tool(name: string, input = "{}"): ConciergeNativeLine | null {
  return conciergeNativeToolLine({ name, input });
}

describe("conciergeNativeToolLine — declining the control path", () => {
  // THE SINGLE MOST IMPORTANT RULE IN THE MODULE. The concierge's control calls already flow through
  // services/controlListener → conciergeActivityLine, which resolves agent ids to names and hands
  // the component a clickable pill. Phrasing them here too would double-record one call AND let
  // "Using sparkle_terminal" race "Reading Kraken Auth's terminal" for the same 360px line.
  it("returns null for every sparkle-control tool", () => {
    const controlTools = [
      "mcp__sparkle-control__sparkle_terminal",
      "mcp__sparkle-control__sparkle_fleet",
      "mcp__sparkle-control__sparkle_lifecycle",
      "mcp__sparkle-control__sparkle_workflow",
      "mcp__sparkle-control__sparkle_review",
      "mcp__sparkle-control__sparkle_board",
      "mcp__sparkle-control__sparkle_diff",
      "mcp__sparkle-control__sparkle_workspace",
      "mcp__sparkle-control__sparkle_screenshot",
      "mcp__sparkle-control__sparkle_events",
      "mcp__sparkle-control__sparkle_plans",
      "mcp__sparkle-control__sparkle_approvals",
      "mcp__sparkle-control__sparkle_attachments",
      "mcp__sparkle-control__get_state",
      "mcp__sparkle-control__rename_agent",
      "mcp__sparkle-control__set_agent_activity",
    ];
    for (const name of controlTools) {
      expect(conciergeNativeToolLine({ name, input: '{"op":"read_agent_terminal"}' })).toBeNull();
    }
  });

  // Any other MCP server is not ours to narrate either: we do not know what its ops mean, and a
  // sentence made up for one would be exactly the confident guess rule 3 forbids.
  it("returns null for any other mcp__ tool rather than inventing a sentence", () => {
    expect(tool("mcp__claude-in-chrome__navigate")).toBeNull();
    expect(tool("mcp__github__create_issue")).toBeNull();
    expect(tool("mcp__some-unknown-server__do_a_thing")).toBeNull();
  });

  // A prefix match, not a substring one: a tool whose name merely mentions mcp is still a tool.
  it("does not decline a tool that only contains 'mcp' later in its name", () => {
    expect(tool("Readmcp__thing")?.present).toBe("Using Readmcp__thing");
  });
});

describe("conciergeNativeToolLine — Bash verb sniffing", () => {
  it("names what git was actually asked to do", () => {
    expect(bash("git push origin HEAD")).toMatchObject({
      present: "Pushing to the remote",
      past: "Pushed to the remote",
    });
    expect(bash("git commit -m 'fix'")).toMatchObject({
      present: "Committing",
      past: "Committed",
    });
    expect(bash("git status --porcelain")).toMatchObject({
      present: "Checking git",
      past: "Checked git",
    });
    expect(bash("git rev-list --count HEAD..origin/main")?.present).toBe("Checking git");
  });

  it("recognises the gh subcommands the concierge actually uses", () => {
    expect(bash("gh pr list --state open")).toMatchObject({
      present: "Checking pull requests",
      past: "Checked pull requests",
    });
    expect(bash("gh run view 123")?.present).toBe("Checking pull requests");
    expect(bash("gh api repos/drodio/sparkle")?.present).toBe("Checking pull requests");
  });

  it("separates filing a bead from reading the board", () => {
    expect(bash("bd create --title 'x'")).toMatchObject({
      present: "Filing a bead",
      past: "Filed a bead",
    });
    expect(bash("bd list --ready")).toMatchObject({
      present: "Reading your task list",
      past: "Read your task list",
    });
  });

  // A catch-all that says "Checking pull requests" while the concierge MERGED one is worse than the
  // generic phrase, not better: a vague true sentence costs the reader nothing and a specific false
  // one is the exact dishonesty this module exists to remove. Each write verb is named on its own.
  it("never reports a mutating subcommand as a read-only one", () => {
    const cases: [string, string, string][] = [
      ["gh pr merge 1234 --merge", "Merging a pull request", "Merged a pull request"],
      ["gh pr create --title x", "Opening a pull request", "Opened a pull request"],
      ["bd close sparkle-abcd", "Closing a task", "Closed a task"],
      ["bd update sparkle-abcd -p 1", "Updating a task", "Updated a task"],
      ["bd delete sparkle-abcd", "Deleting a task", "Deleted a task"],
      ["git rebase origin/main", "Rebasing", "Rebased"],
      ["git merge --no-ff topic", "Merging a branch", "Merged a branch"],
      ["git reset --hard HEAD", "Resetting the branch", "Reset the branch"],
      ["git checkout -b topic", "Switching branches", "Switched branches"],
      ["git switch main", "Switching branches", "Switched branches"],
      ["git add -A", "Staging changes", "Staged changes"],
    ];
    for (const [command, present, past] of cases) {
      expect(bash(command), command).toMatchObject({ present, past });
    }
    // And the read catch-alls are still what they were for the reads, which are the common case.
    expect(bash("gh pr view 1234")?.present).toBe("Checking pull requests");
    expect(bash("bd list")?.present).toBe("Reading your task list");
    expect(bash("git status")?.present).toBe("Checking git");
  });

  it("phrases roborev as code review, not as the daemon's name", () => {
    expect(bash("roborev list --open")).toMatchObject({
      present: "Checking code review findings",
      past: "Checked code review findings",
    });
  });

  it("recognises test and build commands", () => {
    for (const command of [
      "pnpm test",
      "npm test",
      "cargo test --all",
      "vitest run src/engine",
      "pnpm vitest run src/engine/x.test.ts",
    ]) {
      expect(bash(command), command).toMatchObject({
        present: "Running the tests",
        past: "Ran the tests",
      });
    }
    for (const command of ["pnpm build", "cargo build --release", "tsc --noEmit", "pnpm tsc"]) {
      expect(bash(command), command).toMatchObject({ present: "Building", past: "Built" });
    }
  });

  it("recognises the search tools", () => {
    for (const command of ["rg conciergeNativeToolLine", "grep -r foo .", "find . -name '*.ts'"]) {
      expect(bash(command), command).toMatchObject({
        present: "Searching the code",
        past: "Searched the code",
      });
    }
  });

  // ── The robustness cases. Each of these is a real shape the concierge emits, and each one reads
  //    as the generic "Running a command" if the sniffer only looks at the first token. ──────────

  it("strips a leading cd so the command after it is what gets named", () => {
    expect(bash("cd /some/path && git status")?.present).toBe("Checking git");
    expect(bash("cd /Users/someone/Projects/app && pnpm test")?.present).toBe("Running the tests");
    expect(bash("cd /tmp; bd create --title x")?.present).toBe("Filing a bead");
  });

  it("strips env-var prefixes", () => {
    expect(bash("FOO=1 gh pr list")?.present).toBe("Checking pull requests");
    expect(bash("EDITOR=true roborev comment 1 -m x")?.present).toBe(
      "Checking code review findings",
    );
    expect(bash("A=1 B=2 git log")?.present).toBe("Checking git");
  });

  it("strips sudo and its flags", () => {
    expect(bash("sudo cargo test")?.present).toBe("Running the tests");
    expect(bash("sudo -E pnpm build")?.present).toBe("Building");
  });

  // AGENTS.md: there is no GNU timeout on this machine, so slow commands are wrapped. Unstripped,
  // the LONGEST calls — the ones the column most needs to name — would all read as generic.
  it("sees through the timeout wrapper to the real command", () => {
    expect(bash("scripts/timeout.sh 300 pnpm test")?.present).toBe("Running the tests");
    expect(bash("scripts/timeout.sh -k 10s 5m cargo build")?.present).toBe("Building");
    expect(bash("timeout 60 git push")?.present).toBe("Pushing to the remote");
  });

  it("takes the first command of a pipeline, not a fragment of it", () => {
    expect(bash("git log --oneline | head -20")?.present).toBe("Checking git");
    expect(bash("rg foo | wc -l")?.present).toBe("Searching the code");
  });

  // RULE 3, the one that matters most in the sniffer: matching is on WHOLE TOKENS. A substring
  // search would call this a git command, which is a confident guess where the honest generic was
  // sitting right there.
  it("does not read a path that merely contains a verb as that verb", () => {
    expect(bash("/home/x/gitlab/run.sh")).toMatchObject({
      present: "Running a command",
      past: "Ran a command",
    });
    expect(bash("./scripts/legit-thing.sh")?.present).toBe("Running a command");
    expect(bash("cat /var/log/findings.txt")?.present).toBe("Running a command");
    expect(bash("echo 'git push'")?.present).toBe("Running a command");
  });

  it("degrades to the generic when the command is missing or empty", () => {
    expect(bash("")).toMatchObject({ present: "Running a command", past: "Ran a command" });
    expect(bash("   ")?.present).toBe("Running a command");
    expect(tool("Bash", '{"description":"do a thing"}')?.present).toBe("Running a command");
    expect(tool("Bash", "{}")?.present).toBe("Running a command");
    expect(bash("cd /some/path")?.present).toBe("Running a command");
  });

  it("names an unknown verb honestly rather than picking the nearest rule", () => {
    expect(bash("open -a Safari")?.present).toBe("Running a command");
    expect(bash("mkdir -p build")?.present).toBe("Running a command");
  });
});

describe("conciergeNativeToolLine — a truncated input never throws", () => {
  // RULE 5. `input` is clamped at 512 chars, so a long Bash command arrives cut off mid-string and
  // JSON.parse throws on a blob whose LEADING bytes — the argv we want — are perfectly intact.
  it("recovers the verb from a JSON blob that was cut off mid-string", () => {
    const truncated = '{"command":"git push origin sparkle/some-very-long-branch-name-that-w';
    expect(conciergeNativeToolLine({ name: "Bash", input: truncated })?.present).toBe(
      "Pushing to the remote",
    );
  });

  it("still recovers the verb when the clamp lands exactly at 512 chars", () => {
    const command = `pnpm test ${"x".repeat(600)}`;
    const clamped = JSON.stringify({ command }).slice(0, 512);
    expect(clamped.length).toBe(512);
    expect(conciergeNativeToolLine({ name: "Bash", input: clamped })?.present).toBe(
      "Running the tests",
    );
  });

  it("degrades to the tool's generic phrase for input it cannot read at all", () => {
    for (const input of ["", "{", '{"comm', "not json at all", "[1,2,3]", "null"]) {
      expect(conciergeNativeToolLine({ name: "Bash", input })?.present, input).toBe(
        "Running a command",
      );
    }
  });

  it("does not throw for any hostile input shape", () => {
    const inputs = [
      "",
      "{",
      '{"command":',
      '{"command":"',
      '{"command":"\\',
      '{"command":123}',
      '{"command":null}',
      "�".repeat(20),
      JSON.stringify({ command: "git status" }).slice(0, 3),
    ];
    for (const input of inputs) {
      expect(() => conciergeNativeToolLine({ name: "Bash", input })).not.toThrow();
      expect(() => conciergeNativeToolLine({ name: "Read", input })).not.toThrow();
    }
    // The interface says `input` is a string; the transport is not typed, so prove it survives one
    // that is not. A throw here would take out the status line for the whole turn.
    expect(() =>
      conciergeNativeToolLine({ name: "Bash" } as unknown as { name: string; input: string }),
    ).not.toThrow();
    expect(conciergeNativeToolLine({ name: "" } as unknown as { name: string; input: string })).toBe(
      null,
    );
  });
});

describe("conciergeNativeToolLine — the non-Bash vocabulary", () => {
  it("names the kind of thing, never the thing itself", () => {
    expect(tool("Read", '{"file_path":"/Users/someone/.ssh/id_rsa"}')).toMatchObject({
      present: "Reading a file",
      past: "Read a file",
    });
    expect(tool("Grep", '{"pattern":"secret"}')).toMatchObject({
      present: "Searching the code",
      past: "Searched the code",
    });
    expect(tool("Glob")?.present).toBe("Searching the code");
    expect(tool("WebFetch", '{"url":"https://example.com/?token=abc"}')).toMatchObject({
      present: "Reading a page",
      past: "Read a page",
    });
  });

  it("phrases the writing, research and planning tools", () => {
    for (const name of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      expect(tool(name), name).toMatchObject({ present: "Writing a file", past: "Wrote a file" });
    }
    for (const name of ["Task", "Agent"]) {
      expect(tool(name), name).toMatchObject({
        icon: "agents",
        present: "Researching in the background",
        past: "Researched in the background",
      });
    }
    for (const name of ["TodoWrite", "TaskCreate", "TaskUpdate"]) {
      expect(tool(name), name).toMatchObject({ present: "Planning", past: "Planned" });
    }
    expect(tool("WebSearch")).toMatchObject({
      present: "Searching the web",
      past: "Searched the web",
    });
    expect(tool("ToolSearch")).toMatchObject({
      present: "Looking up a tool",
      past: "Looked up a tool",
    });
  });

  // The same choice conciergeActivityLine makes for an un-phrased op: the tool's NAME is a fact, so
  // show it verbatim rather than dress it in a sentence this module made up. Visibly un-polished, so
  // somebody writes it a real phrase.
  it("shows an unrecognised tool's own name verbatim, in both tenses", () => {
    expect(tool("Frobnicate")).toMatchObject({
      present: "Using Frobnicate",
      past: "Used Frobnicate",
    });
    expect(tool("BashOutput")?.present).toBe("Using BashOutput");
    expect(tool("KillShell")?.past).toBe("Used KillShell");
  });

  // A `TABLE[name]` lookup with a caller-supplied key reaches Object.prototype, so these names
  // returned a FUNCTION that passed the truthiness check and was handed back as if it were a line —
  // the consumer then reads `line.present` as undefined and `line.present.trim()` throws, breaking
  // both of this module's contracts at once. The lookup goes through a Map now.
  it("does not mistake an Object.prototype member for a phrase", () => {
    for (const name of [
      "toString",
      "valueOf",
      "constructor",
      "hasOwnProperty",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "__proto__",
      "__defineGetter__",
    ]) {
      const line = tool(name);
      expect(line, name).not.toBeNull();
      expect(typeof line?.present, name).toBe("string");
      expect(typeof line?.past, name).toBe("string");
      expect(line?.present, name).toBe(`Using ${name}`);
      expect(line?.past, name).toBe(`Used ${name}`);
      expect(() => line?.present.trim(), name).not.toThrow();
    }
  });

  // The name is rendered, so it is treated as untrusted — that is what keeps the no-path invariant
  // true for a tool name nobody anticipated.
  it("sanitises a tool name before rendering it", () => {
    const line = tool("Evil/../../etc/passwd~");
    expect(line?.present).toBe("Using Evil....etcpasswd");
    expect(line?.present).not.toContain("/");
    expect(line?.present).not.toContain("~");
    // Nothing left after sanitising means there is no fact to report; the plain pulse is honest.
    expect(tool("///")).toBeNull();
    expect(tool("")).toBeNull();
  });
});

// ── Invariants swept over the WHOLE vocabulary ──────────────────────────────────────────────────
// Asserted programmatically rather than case by case, so an entry added later cannot slip past
// them. Each of these is a rule from the module header, checked on real returned phrases.

/** Every line the module can produce, driven through the real function. */
const ALL_LINES: { label: string; line: ConciergeNativeLine }[] = [
  ...Object.keys(CONCIERGE_NATIVE_TOOL_LINES).map((name) => {
    const line = conciergeNativeToolLine({ name, input: "{}" });
    if (!line) throw new Error(`no line for ${name}`);
    return { label: name, line };
  }),
  ...BASH_RULES.map((rule) => {
    const command = `${rule.argv.join(" ")} --flag=/Users/someone/Projects/sekrit ~/notes.txt`;
    const line = bash(command);
    if (!line) throw new Error(`no line for ${command}`);
    return { label: command, line };
  }),
  { label: "unknown tool", line: tool("Frobnicate") as ConciergeNativeLine },
];

describe("conciergeNativeToolLine — invariants over the whole vocabulary", () => {
  it("covers every table entry", () => {
    // Guards the sweeps below: an empty list would make all of them pass trivially.
    expect(ALL_LINES.length).toBe(
      Object.keys(CONCIERGE_NATIVE_TOOL_LINES).length + BASH_RULES.length + 1,
    );
    expect(BASH_RULES.length).toBeGreaterThan(15);
  });

  // RULE 2. A single present-tense phrase leaves the column claiming to be doing something it
  // finished seconds ago — the exact failure this feature exists to avoid.
  it("gives every entry two DIFFERENT, non-empty tenses", () => {
    for (const { label, line } of ALL_LINES) {
      expect(line.present.trim(), label).not.toBe("");
      expect(line.past.trim(), label).not.toBe("");
      expect(line.past, label).not.toBe(line.present);
    }
  });

  // RULE 4. This is a shared 360px surface; a path leaked into a concierge surface once already and
  // had to be stripped out.
  it("never puts a path, a home marker or the raw command in a phrase", () => {
    for (const { label, line } of ALL_LINES) {
      for (const text of [line.present, line.past]) {
        expect(text, label).not.toMatch(/[/\\~]/);
        expect(text, label).not.toContain("sekrit");
        expect(text, label).not.toContain("Users");
        expect(text, label).not.toContain("--flag");
        expect(text, label).not.toContain(".txt");
      }
    }
  });

  it("only ever uses the four known glyph families", () => {
    for (const { label, line } of ALL_LINES) {
      expect(["agents", "terminal", "workflow", "workspace"], label).toContain(line.icon);
    }
  });

  // The same sentence wearing two different glyphs on two consecutive lines reads as two different
  // activities. Shared phrases must share their icon.
  it("gives one sentence exactly one glyph", () => {
    const byPhrase = new Map<string, string>();
    for (const { label, line } of ALL_LINES) {
      const seen = byPhrase.get(line.present);
      if (seen) expect(line.icon, `${label} vs earlier "${line.present}"`).toBe(seen);
      byPhrase.set(line.present, line.icon);
    }
  });

  // The table is authored general-case-first (`git` above `git push`), which is the readable order
  // and the order in which a shorter rule WOULD swallow a longer one if specificity were not sorted
  // for. Asserted through the real function, so deleting the sort turns this red instead of quietly
  // renaming half the git vocabulary to "Checking git".
  it("never lets a shorter rule shadow a longer one that extends it", () => {
    const pairs = BASH_RULES.flatMap((rule) =>
      BASH_RULES.filter(
        (other) =>
          other.argv.length < rule.argv.length &&
          other.argv.every((token, i) => token === rule.argv[i]),
      ).map((shorter) => ({ rule, shorter })),
    );
    expect(pairs.length).toBeGreaterThan(2);
    for (const { rule, shorter } of pairs) {
      const command = rule.argv.join(" ");
      expect(bash(command)?.present, command).toBe(rule.line.present);
      expect(bash(command)?.present, command).not.toBe(shorter.line.present);
    }
  });

  // Every Bash rule must survive the wrappers, or the rule is only half-implemented: `cd … &&` and
  // an env prefix are the two shapes the concierge emits most.
  it("resolves every Bash rule through a cd and an env prefix too", () => {
    for (const rule of BASH_RULES) {
      const bare = bash(rule.argv.join(" "));
      expect(bare?.present, rule.argv.join(" ")).toBe(rule.line.present);
      expect(bash(`cd /some/path && ${rule.argv.join(" ")}`)?.present, rule.argv.join(" ")).toBe(
        rule.line.present,
      );
      expect(bash(`FOO=1 ${rule.argv.join(" ")}`)?.present, rule.argv.join(" ")).toBe(
        rule.line.present,
      );
    }
  });
});
