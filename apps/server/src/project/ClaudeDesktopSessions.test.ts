import { describe, expect, it } from "vite-plus/test";

import { parseClaudeDesktopLineage } from "./ClaudeDesktopSessions.ts";

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
    });
  });
});
