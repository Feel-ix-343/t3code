import { describe, expect, it } from "vite-plus/test";

import {
  mergeSidebarSections,
  moveSidebarSection,
  planSidebarArrangeDrop,
  resolveSidebarArrangeTarget,
  type SidebarArrangeItem,
} from "./sidebarArrangement.logic";

const thread = (key: string): SidebarArrangeItem => ({ kind: "thread", key });
const items: SidebarArrangeItem[] = [
  thread("p1"),
  thread("p2"),
  { kind: "boundary", id: "section:work", container: { kind: "pinned", sectionId: "work" } },
  thread("w1"),
  { kind: "boundary", id: "section:empty", container: { kind: "pinned", sectionId: "empty" } },
  { kind: "boundary", id: "section:empty:placeholder", container: null },
  { kind: "boundary", id: "folder:a", container: { kind: "folder", projectKey: "a" } },
  thread("a1"),
  thread("a2"),
  thread("a3"),
  { kind: "boundary", id: "settled", container: null },
  thread("s1"),
];

describe("resolveSidebarArrangeTarget", () => {
  it("reads the destination list after the move", () => {
    expect(resolveSidebarArrangeTarget(items, "a3", "a1")).toEqual({
      container: { kind: "folder", projectKey: "a" },
      order: ["a3", "a1", "a2"],
    });
    expect(resolveSidebarArrangeTarget(items, "p1", "w1")).toEqual({
      container: { kind: "pinned", sectionId: "work" },
      order: ["w1", "p1"],
    });
    expect(resolveSidebarArrangeTarget(items, "w1", "p1")).toEqual({
      container: { kind: "pinned", sectionId: null },
      order: ["w1", "p1", "p2"],
    });
  });

  it("drops onto an empty section's placeholder from either side", () => {
    const placeholderItems = items.map((item) =>
      item.kind === "boundary" && item.id === "section:empty:placeholder"
        ? { ...item, container: { kind: "pinned" as const, sectionId: "empty" } }
        : item,
    );
    expect(
      resolveSidebarArrangeTarget(placeholderItems, "a1", "section:empty:placeholder")?.container,
    ).toEqual({ kind: "pinned", sectionId: "empty" });
    expect(
      resolveSidebarArrangeTarget(placeholderItems, "p1", "section:empty:placeholder")?.container,
    ).toEqual({ kind: "pinned", sectionId: "empty" });
  });

  it("refuses rows past the arranged lists", () => {
    expect(resolveSidebarArrangeTarget(items, "a1", "s1")).toBeNull();
  });
});

describe("planSidebarArrangeDrop", () => {
  const pinKeysById = new Map([
    ["p1", "f"],
    ["p2", "m"],
    ["w1", "f"],
  ]);
  const activeKeysById = new Map<string, string | null>([
    ["a1", null],
    ["a2", null],
    ["a3", null],
  ]);

  it("keys a whole folder the first time it is arranged", () => {
    expect(
      planSidebarArrangeDrop({
        thread: { key: "a3", pinned: false, sectionId: null, folderKey: "a" },
        target: { container: { kind: "folder", projectKey: "a" }, order: ["a3", "a1", "a2"] },
        sourceOrder: ["a1", "a2", "a3"],
        pinKeysById,
        activeKeysById,
      }),
    ).toMatchObject({ kind: "reorder-folder", unpin: false, assignments: expect.any(Array) });
  });

  it("keeps a thread out of another project's folder", () => {
    expect(
      planSidebarArrangeDrop({
        thread: { key: "b1", pinned: false, sectionId: null, folderKey: "b" },
        target: { container: { kind: "folder", projectKey: "a" }, order: ["a1", "b1"] },
        sourceOrder: ["b1"],
        pinKeysById,
        activeKeysById,
      }),
    ).toEqual({ kind: "none" });
  });

  it("unpins a pinned thread dropped into its own folder", () => {
    expect(
      planSidebarArrangeDrop({
        thread: { key: "p1", pinned: true, sectionId: null, folderKey: "a" },
        target: { container: { kind: "folder", projectKey: "a" }, order: ["a1", "p1"] },
        sourceOrder: ["p1", "p2"],
        pinKeysById,
        activeKeysById,
      }),
    ).toMatchObject({ kind: "reorder-folder", unpin: true });
  });

  it("pins an active thread into a section", () => {
    expect(
      planSidebarArrangeDrop({
        thread: { key: "a1", pinned: false, sectionId: null, folderKey: "a" },
        target: { container: { kind: "pinned", sectionId: "work" }, order: ["w1", "a1"] },
        sourceOrder: ["a1", "a2", "a3"],
        pinKeysById,
        activeKeysById,
      }),
    ).toMatchObject({ kind: "pin", sectionId: "work", others: [] });
  });

  it("moves a pin between sections", () => {
    expect(
      planSidebarArrangeDrop({
        thread: { key: "p2", pinned: true, sectionId: null, folderKey: "a" },
        target: { container: { kind: "pinned", sectionId: "empty" }, order: ["p2"] },
        sourceOrder: ["p1", "p2"],
        pinKeysById,
        activeKeysById,
      }),
    ).toEqual({
      kind: "reorder-pinned",
      sectionId: "empty",
      assignments: [{ id: "p2", orderKey: expect.any(String) }],
    });
  });

  it("skips a drop that leaves the list as it was", () => {
    expect(
      planSidebarArrangeDrop({
        thread: { key: "p1", pinned: true, sectionId: null, folderKey: "a" },
        target: { container: { kind: "pinned", sectionId: null }, order: ["p1", "p2"] },
        sourceOrder: ["p1", "p2"],
        pinKeysById,
        activeKeysById,
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("sidebar sections", () => {
  const work = { id: "work", title: "Work" };
  const home = { id: "home", title: "Home" };
  const misc = { id: "misc", title: "Misc" };

  it("merges environments by id in first-seen order", () => {
    expect(
      mergeSidebarSections([
        [work, home],
        [misc, work],
      ]),
    ).toEqual([work, home, misc]);
  });

  it("moves a section before another or to the end", () => {
    expect(moveSidebarSection([work, home, misc], "misc", "work")).toEqual([misc, work, home]);
    expect(moveSidebarSection([work, home, misc], "work", null)).toEqual([home, misc, work]);
  });
});
