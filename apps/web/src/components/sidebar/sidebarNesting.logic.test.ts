import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { nestSidebarThreads, sidebarNestParentId } from "./sidebarNesting.logic";

type Row = { readonly key: string; readonly parent: string | null };
const row = (key: string, parent: string | null = null): Row => ({ key, parent });
const nest = (rows: readonly Row[], collapsed: readonly string[] = [], keep?: string) =>
  nestSidebarThreads(rows, {
    keyOf: (r) => r.key,
    parentKeyOf: (r) => r.parent,
    isCollapsed: (key) => collapsed.includes(key),
    keepVisibleKey: keep ?? null,
  }).map(
    (r) => `${"  ".repeat(r.depth)}${r.thread.key}${r.collapsed ? ` (+${r.descendantCount})` : ""}`,
  );

describe("nestSidebarThreads", () => {
  it("moves children below their parent in list order and leaves orphans in place", () => {
    expect(
      nest([row("c2", "a"), row("b"), row("a"), row("orphan", "elsewhere"), row("c1", "a")]),
    ).toEqual(["b", "a", "  c2", "  c1", "orphan"]);
  });

  it("nests grandchildren and counts every descendant of a collapsed parent", () => {
    const rows = [row("a"), row("b", "a"), row("c", "b"), row("d")];
    expect(nest(rows)).toEqual(["a", "  b", "    c", "d"]);
    expect(nest(rows, ["a"])).toEqual(["a (+2)", "d"]);
    expect(nest(rows, ["b"])).toEqual(["a", "  b (+1)", "d"]);
  });

  it("keeps the open thread under its collapsed ancestor", () => {
    expect(nest([row("a"), row("b", "a"), row("c", "b")], ["a"], "c")).toEqual(["a (+2)", "  c"]);
  });

  it("ignores collapse on a thread with no children", () => {
    expect(nest([row("a"), row("b")], ["a"])).toEqual(["a", "b"]);
  });

  it("breaks a cycle instead of dropping its threads", () => {
    expect(nest([row("a", "b"), row("b", "a"), row("c", "c")])).toEqual(["a", "  b", "c"]);
  });
});

describe("sidebarNestParentId", () => {
  const parent = ThreadId.make("parent");
  const root = ThreadId.make("self");
  it("nests launched threads and forks, not side chats or subagents", () => {
    expect(
      sidebarNestParentId({
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: root,
        spawnedBy: parent,
      }),
    ).toBe(parent);
    expect(
      sidebarNestParentId({
        parentThreadId: parent,
        relationshipToParent: "fork",
        rootThreadId: parent,
      }),
    ).toBe(parent);
    expect(
      sidebarNestParentId({
        parentThreadId: parent,
        relationshipToParent: "fork",
        rootThreadId: parent,
        sideChat: true,
      }),
    ).toBeNull();
    expect(
      sidebarNestParentId({
        parentThreadId: parent,
        relationshipToParent: "subagent",
        rootThreadId: parent,
      }),
    ).toBeNull();
  });
});
