import { describe, expect, it } from "@effect/vitest";

import {
  claudeProjectDirectoryName,
  movedBranchName,
  rehomeClaudeTranscript,
} from "./threadMovePlan.ts";

describe("rehomeClaudeTranscript", () => {
  it("moves cwds under the old checkout and drops a line still being written", () => {
    const text = [
      JSON.stringify({ type: "user", cwd: "/Users/f/app", sessionId: "s" }),
      JSON.stringify({ type: "assistant", cwd: "/Users/f/app/web" }),
      JSON.stringify({ type: "user", cwd: "/Users/f/application" }),
      JSON.stringify({ type: "summary" }),
      "not json",
      '{"type":"assistant","cwd":"/Users/f/a',
    ].join("\n");
    expect(rehomeClaudeTranscript(text, "/Users/f/app", "/box/wt").split("\n")).toEqual([
      JSON.stringify({ type: "user", cwd: "/box/wt", sessionId: "s" }),
      JSON.stringify({ type: "assistant", cwd: "/box/wt/web" }),
      // A sibling that only shares the prefix is not inside the checkout.
      JSON.stringify({ type: "user", cwd: "/box/wt" }),
      JSON.stringify({ type: "summary" }),
      "not json",
      "",
    ]);
  });
});

describe("movedBranchName", () => {
  it.each<[{ branch: string | null; defaultBranch: string | null }, string]>([
    [{ branch: "feature/x", defaultBranch: "main" }, "feature/x"],
    [{ branch: "main", defaultBranch: "main" }, "t3/moved-abcd1234"],
    [{ branch: "HEAD", defaultBranch: "main" }, "t3/moved-abcd1234"],
    [{ branch: null, defaultBranch: null }, "t3/moved-abcd1234"],
  ])("%j pushes to %s", (input, expected) => {
    expect(movedBranchName({ ...input, threadId: "thread:ab-cd1234" })).toBe(expected);
  });
});

it("names Claude Code's project folder as Claude Code does", () => {
  expect(claudeProjectDirectoryName("/home/u/.t3/worktrees/app/feat-x_1")).toBe(
    "-home-u--t3-worktrees-app-feat-x-1",
  );
});
