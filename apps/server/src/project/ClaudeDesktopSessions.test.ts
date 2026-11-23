import { describe, expect, it } from "vite-plus/test";

import {
  parseClaudeDesktopLineage,
  parseClaudeDesktopOrganization,
} from "./ClaudeDesktopSessions.ts";

const session = (fields: Record<string, unknown>) => JSON.stringify(fields);

describe("parseClaudeDesktopLineage", () => {
  it("maps desktop session ids to CLI session ids and marks btw side chats", () => {
    const lineage = parseClaudeDesktopLineage([
      session({ sessionId: "local_parent", cliSessionId: "cli-parent" }),
      session({
        sessionId: "local_spawned",
        cliSessionId: "cli-spawned",
        spawnedFrom: { sessionId: "local_parent", taskId: "task_1", sideSession: true },
      }),
      session({
        sessionId: "local_btw",
        cliSessionId: "cli-btw",
        spawnedFrom: { sessionId: "local_parent", sideSession: true, btw: true },
        forkedFromSessionId: "local_parent",
      }),
      session({
        sessionId: "local_fork",
        cliSessionId: "cli-fork",
        forkedFromSessionId: "local_spawned",
      }),
      // Detached in the desktop app, or naming a parent this machine does not have.
      session({
        sessionId: "local_detached",
        cliSessionId: "cli-detached",
        spawnedFrom: { sessionId: "local_parent" },
        lineageDetached: true,
      }),
      // Spawned from one session but forked from another: the desktop app shows the fork parent.
      session({
        sessionId: "local_stacking",
        cliSessionId: "cli-stacking",
        spawnedFrom: { sessionId: "local_parent" },
        forkedFromSessionId: "local_fork",
      }),
      // A fork parent this machine lacks falls back to the spawning session.
      session({
        sessionId: "local_fork_gone",
        cliSessionId: "cli-fork-gone",
        spawnedFrom: { sessionId: "local_parent" },
        forkedFromSessionId: "local_gone",
      }),
      session({
        sessionId: "local_orphan",
        cliSessionId: "cli-orphan",
        spawnedFrom: { sessionId: "local_gone" },
      }),
      "not json",
      session({ sessionId: "local_missing_cli" }),
    ]);
    expect(Object.fromEntries(lineage)).toEqual({
      "cli-spawned": { parentSessionId: "cli-parent", sideChat: false },
      "cli-btw": { parentSessionId: "cli-parent", sideChat: true },
      "cli-fork": { parentSessionId: "cli-spawned", sideChat: false },
      "cli-stacking": { parentSessionId: "cli-fork", sideChat: false },
      "cli-fork-gone": { parentSessionId: "cli-parent", sideChat: false },
    });
  });
});

describe("parseClaudeDesktopOrganization", () => {
  const scope = "account/org";
  const config = (epitaxyPrefs: Record<string, unknown>) =>
    JSON.stringify({ preferences: { epitaxyPrefs } });
  const metadata = [
    session({ sessionId: "local_a", cliSessionId: "cli-a" }),
    session({ sessionId: "local_b", cliSessionId: "cli-b", isStarred: true }),
    session({ sessionId: "local_c", cliSessionId: "cli-c" }),
    session({ sessionId: "local_old", cliSessionId: "cli-old", isArchived: true }),
  ];

  it("reads sections in order, assignments by CLI session, and stars in pinned order", () => {
    const organization = parseClaudeDesktopOrganization(
      config({
        "dframe-code-sections": {
          [scope]: {
            sections: [
              { id: "pinned", kind: "pinned", name: "", order: 0 },
              { id: "cg-2", kind: "manual", name: "Second", order: 3 },
              { id: "cg-1", kind: "manual", name: " First ", order: 2 },
            ],
          },
        },
        "dframe-group-scopes": {
          [scope]: {
            groups: [{ id: "cg-3", name: "Only a group" }],
            assignments: {
              "code:local_a": "cg-1",
              "code:local_c": "cg-3",
              "code:local_old": "cg-1",
              "code:local_unknown": "cg-2",
              "code:local_b": "cg-gone",
            },
          },
        },
        "starred-local-code-sessions": ["local_a", "local_old"],
        "dframe-local-slice": { pinnedOrder: ["code:local_b", "code:local_a", "code:local_c"] },
      }),
      metadata,
    );
    expect(organization.sections).toEqual([
      { id: "cg-1", name: "First" },
      { id: "cg-2", name: "Second" },
      { id: "cg-3", name: "Only a group" },
    ]);
    expect(Object.fromEntries(organization.sectionBySession)).toEqual({
      "cli-a": "cg-1",
      "cli-c": "cg-3",
    });
    // Starred in the list or the session's metadata; archived and unstarred ones are left out.
    expect(organization.starred).toEqual(["cli-b", "cli-a"]);
  });

  it("organizes nothing from an unreadable config", () => {
    expect(parseClaudeDesktopOrganization("{", metadata)).toEqual({
      sections: [],
      sectionBySession: new Map(),
      starred: ["cli-b"],
    });
  });
});
