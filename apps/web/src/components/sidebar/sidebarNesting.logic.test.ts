import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  gatherChildrenToParents,
  nestSidebarThreads,
  planNestedRowDrop,
  sidebarNestParentId,
} from "./sidebarNesting.logic";

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

describe("sidebarNestParentId placement", () => {
  const spawner = ThreadId.make("spawner");
  const chosen = ThreadId.make("chosen");
  const lineage = {
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: ThreadId.make("self"),
    spawnedBy: spawner,
  } as const;
  it("follows where the thread was placed over the thread that spawned it", () => {
    expect(sidebarNestParentId({ ...lineage, nestParentThreadId: null })).toBeNull();
    expect(sidebarNestParentId({ ...lineage, nestParentThreadId: chosen })).toBe(chosen);
    expect(
      sidebarNestParentId({
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: ThreadId.make("self"),
        nestParentThreadId: chosen,
      }),
    ).toBe(chosen);
  });
});

describe("gatherChildrenToParents", () => {
  const gather = (
    lists: ReadonlyArray<{ readonly threads: readonly Row[]; readonly canLeave: boolean }>,
  ) =>
    gatherChildrenToParents(lists, { keyOf: (r) => r.key, parentKeyOf: (r) => r.parent }).map(
      (threads) => threads.map((r) => r.key),
    );

  it("moves a child, and its own child, into the list its parent is in", () => {
    expect(
      gather([
        { threads: [row("pinned-parent")], canLeave: false },
        { threads: [row("local")], canLeave: true },
        {
          threads: [row("grandchild", "child"), row("child", "pinned-parent"), row("other")],
          canLeave: true,
        },
      ]),
    ).toEqual([["child", "grandchild", "pinned-parent"], ["local"], ["other"]]);
  });

  it("puts gathered children at the top of the list, in their own order", () => {
    expect(
      gather([
        { threads: [row("arranged"), row("parent")], canLeave: false },
        { threads: [row("newer", "parent"), row("older", "parent")], canLeave: true },
      ]),
    ).toEqual([["newer", "older", "arranged", "parent"], []]);
  });

  it("leaves children in lists that cannot give them up, and cycles in place", () => {
    expect(
      gather([
        { threads: [row("parent")], canLeave: true },
        { threads: [row("settled-child", "parent")], canLeave: false },
        { threads: [row("a", "b")], canLeave: true },
        { threads: [row("b", "a")], canLeave: true },
      ]),
    ).toEqual([["parent"], ["settled-child"], ["a"], ["b"]]);
  });
});

describe("planNestedRowDrop", () => {
  // Stored order: p, x, a, b, c, y; shown: p, a, b, c (children of p), x, y.
  const parents: Record<string, string | null> = { a: "p", b: "p", c: "p", g: "a" };
  const plan = (key: string, shownOrder: readonly string[], storedOrder: readonly string[]) =>
    planNestedRowDrop({
      key,
      parentKey: "p",
      shownOrder,
      storedOrder,
      parentKeyOf: (candidate) => parents[candidate] ?? null,
    });
  const stored = ["p", "x", "a", "b", "c", "y"];

  it("reorders a child among its siblings and keeps it nested", () => {
    expect(plan("c", ["p", "c", "a", "b", "x", "y"], stored)).toEqual({
      kind: "stay",
      order: ["p", "x", "c", "a", "b", "y"],
    });
    expect(plan("a", ["p", "b", "a", "c", "x", "y"], stored)).toEqual({
      kind: "stay",
      order: ["p", "x", "b", "a", "c", "y"],
    });
    expect(plan("a", ["p", "b", "c", "a", "x", "y"], stored)).toEqual({
      kind: "stay",
      order: ["p", "x", "b", "c", "a", "y"],
    });
  });

  it("places a child dropped inside a sibling's own group after that sibling", () => {
    expect(plan("c", ["p", "a", "c", "g", "b", "x"], ["p", "a", "g", "b", "c", "x"])).toEqual({
      kind: "stay",
      order: ["p", "a", "g", "c", "b", "x"],
    });
  });

  it("leaves the group above the parent or past the group's end", () => {
    expect(plan("b", ["b", "p", "a", "c", "x", "y"], stored)).toEqual({ kind: "leave" });
    expect(plan("b", ["p", "a", "c", "x", "b", "y"], stored)).toEqual({ kind: "leave" });
  });
});
