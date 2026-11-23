import { describe, expect, it } from "@effect/vitest";

import * as Schema from "effect/Schema";

import {
  ThreadReceiveInput,
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
    // Without a known default branch, the current one may be it.
    [{ branch: "main", defaultBranch: null }, "t3/moved-abcd1234"],
  ])("%j pushes to %s", (input, expected) => {
    expect(movedBranchName({ ...input, threadId: "thread:ab-cd1234" })).toBe(expected);
  });
});

it("names Claude Code's project folder as Claude Code does", () => {
  expect(claudeProjectDirectoryName("/home/u/.t3/worktrees/app/feat-x_1")).toBe(
    "-home-u--t3-worktrees-app-feat-x-1",
  );
});

const accepts = Schema.is(ThreadReceiveInput);

describe("ThreadReceiveInput", () => {
  const valid = {
    projectId: "box-app",
    title: "Moved",
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus" },
    branch: "feature/x",
    commit: "0123456789abcdef0123456789abcdef01234567",
    history: [],
  };
  const session = (sessionId: string) => ({
    ...valid,
    claudeSession: { sessionId, cwd: "/Users/f/app", transcript: "" },
  });

  it("takes only a session UUID, so a peer cannot name another file", () => {
    expect(accepts(session("0f8fad5b-d9cb-469f-a165-70867728950e"))).toBe(true);
    expect(accepts(session("../../.ssh/authorized_keys"))).toBe(false);
  });

  it("takes only a full commit id", () => {
    expect(accepts(valid)).toBe(true);
    expect(accepts({ ...valid, commit: "--upload-pack=x" })).toBe(false);
  });
});
