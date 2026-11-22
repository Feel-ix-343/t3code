import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { importedClaudeSessionId, planClaudeOrganization } from "./claudeSessionSync.ts";

const pinnedAt = DateTime.makeUnsafe("2026-11-10T00:00:00.000Z");
const thread = (session: string, pinSectionId?: string | null) => ({
  id: ThreadId.make(`import:claudeAgent:${session}`),
  pinnedAt: pinSectionId === undefined ? null : pinnedAt,
  pinSectionId: pinSectionId ?? null,
});

describe("importedClaudeSessionId", () => {
  it("reads the session of a Claude import only", () => {
    expect(importedClaudeSessionId("import:claudeAgent:abc")).toBe("abc");
    expect(importedClaudeSessionId("import:claudeAgent-work:abc")).toBe("abc");
    expect(importedClaudeSessionId("import:codex:abc")).toBeNull();
    expect(importedClaudeSessionId("thread-1")).toBeNull();
  });
});

describe("planClaudeOrganization", () => {
  const organization = {
    sections: [
      { id: "cg-legal", name: "Legal" },
      { id: "cg-fin", name: "finsearch" },
      { id: "cg-empty", name: "Nothing imported" },
    ],
    sectionBySession: new Map([
      ["kept", "cg-fin"],
      ["placed", "cg-legal"],
    ]),
    starred: ["starred", "kept", "unassigned"],
  };
  const sections = [
    { id: "fin", title: "FinSearch" },
    { id: "mine", title: "Mine" },
  ];

  it("matches sections by title, creates the missing ones it fills, and leaves the user's own", () => {
    expect(
      planClaudeOrganization({
        organization,
        sections,
        threads: [
          thread("kept", "fin"),
          thread("placed", null),
          thread("unassigned", "mine"),
          thread("starred"),
        ],
        applySections: true,
        applyPins: true,
      }),
    ).toEqual({
      createSections: ["Legal"],
      placements: [
        { threadId: "import:claudeAgent:placed", sectionTitle: "Legal", from: "Pinned" },
      ],
      // "unassigned" is already pinned, in the user's own section, and stays there.
      pins: ["import:claudeAgent:starred"],
    });
  });

  it("skips sections or pins when asked", () => {
    const threads = [thread("placed"), thread("starred")];
    expect(
      planClaudeOrganization({
        organization,
        sections,
        threads,
        applySections: false,
        applyPins: true,
      }),
    ).toEqual({ createSections: [], placements: [], pins: ["import:claudeAgent:starred"] });
    expect(
      planClaudeOrganization({
        organization,
        sections,
        threads,
        applySections: true,
        applyPins: false,
      }).pins,
    ).toEqual([]);
  });
});
