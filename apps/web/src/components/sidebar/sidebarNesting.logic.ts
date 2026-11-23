import {
  type OrchestrationV2AppThreadLineage,
  type ThreadId,
  threadNestParentId,
} from "@t3tools/contracts";

/**
 * The thread the sidebar nests another under: the one it was placed under, else the one it was
 * launched or forked from. A thread unnested by hand has none.
 */
export function sidebarNestParentId(lineage: OrchestrationV2AppThreadLineage): ThreadId | null {
  return threadNestParentId(lineage);
}

export interface SidebarNestedRow<T> {
  readonly thread: T;
  readonly depth: number;
  /** Every thread nested below this one in the list, shown or not. */
  readonly descendantCount: number;
  readonly collapsed: boolean;
}

/**
 * Moves each thread whose nest parent is in the same list to just below that parent, keeping the
 * list's order among siblings. Threads whose parent is elsewhere stay where they are. A collapsed
 * parent hides its descendants except `keepVisibleKey`, the open thread.
 */
export function nestSidebarThreads<T>(
  threads: readonly T[],
  options: {
    readonly keyOf: (thread: T) => string;
    readonly parentKeyOf: (thread: T) => string | null;
    readonly isCollapsed: (key: string) => boolean;
    readonly keepVisibleKey?: string | null;
  },
): SidebarNestedRow<T>[] {
  const byKey = new Map(threads.map((thread) => [options.keyOf(thread), thread] as const));
  const parentOf = new Map<string, string>();
  for (const [key, thread] of byKey) {
    const parentKey = options.parentKeyOf(thread);
    if (parentKey !== null && parentKey !== key && byKey.has(parentKey)) {
      parentOf.set(key, parentKey);
    }
  }
  // A cycle has no root to hang from, so the first of its threads becomes one.
  for (const key of byKey.keys()) {
    const seen = new Set([key]);
    for (
      let ancestor = parentOf.get(key);
      ancestor !== undefined;
      ancestor = parentOf.get(ancestor)
    ) {
      if (seen.has(ancestor)) {
        parentOf.delete(key);
        break;
      }
      seen.add(ancestor);
    }
  }
  if (parentOf.size === 0) {
    return threads.map((thread) => ({ thread, depth: 0, descendantCount: 0, collapsed: false }));
  }
  const childrenOf = new Map<string, T[]>();
  for (const thread of threads) {
    const parentKey = parentOf.get(options.keyOf(thread));
    if (parentKey === undefined) continue;
    const siblings = childrenOf.get(parentKey);
    if (siblings === undefined) childrenOf.set(parentKey, [thread]);
    else siblings.push(thread);
  }
  const descendants = (key: string): T[] =>
    (childrenOf.get(key) ?? []).flatMap((child) => [child, ...descendants(options.keyOf(child))]);

  const rows: SidebarNestedRow<T>[] = [];
  const visit = (thread: T, depth: number) => {
    const key = options.keyOf(thread);
    const below = descendants(key);
    const collapsed = below.length > 0 && options.isCollapsed(key);
    rows.push({ thread, depth, descendantCount: below.length, collapsed });
    if (!collapsed) {
      for (const child of childrenOf.get(key) ?? []) visit(child, depth + 1);
      return;
    }
    const kept = below.find((candidate) => options.keyOf(candidate) === options.keepVisibleKey);
    if (kept !== undefined) {
      rows.push({ thread: kept, depth: depth + 1, descendantCount: 0, collapsed: false });
    }
  };
  for (const thread of threads) {
    if (!parentOf.has(options.keyOf(thread))) visit(thread, 0);
  }
  return rows;
}

/**
 * Nesting only happens within one list, so each thread `parentKeyOf` names whose parent sits in
 * another list moves to the top of that list, where nesting puts it first under the parent, as
 * new rows go. Only lists with `canLeave` give threads up; a moved child's own children follow it.
 */
export function gatherChildrenToParents<T>(
  lists: ReadonlyArray<{ readonly threads: readonly T[]; readonly canLeave: boolean }>,
  options: {
    readonly keyOf: (thread: T) => string;
    readonly parentKeyOf: (thread: T) => string | null;
  },
): T[][] {
  const result = lists.map((list) => [...list.threads]);
  const listOf = new Map<string, number>();
  const parentOf = new Map<string, string>();
  result.forEach((threads, index) => {
    for (const thread of threads) {
      const key = options.keyOf(thread);
      listOf.set(key, index);
      const parentKey = options.parentKeyOf(thread);
      if (parentKey !== null && parentKey !== key) parentOf.set(key, parentKey);
    }
  });
  const inCycle = (key: string) => {
    const seen = new Set([key]);
    for (let at = parentOf.get(key); at !== undefined; at = parentOf.get(at)) {
      if (seen.has(at)) return true;
      seen.add(at);
    }
    return false;
  };
  const leaves = new Map<string, boolean>();
  result.forEach((threads, index) => {
    for (const thread of threads) leaves.set(options.keyOf(thread), lists[index]!.canLeave);
  });
  const gatheredCount = result.map(() => 0);
  for (let changed = true; changed;) {
    changed = false;
    for (const [key, parentKey] of parentOf) {
      const from = listOf.get(key);
      const to = listOf.get(parentKey);
      if (from === undefined || to === undefined || from === to) continue;
      if (leaves.get(key) !== true || inCycle(key)) continue;
      const index = result[from]!.findIndex((thread) => options.keyOf(thread) === key);
      const [thread] = result[from]!.splice(index, 1);
      result[to]!.splice(gatheredCount[to]!, 0, thread!);
      gatheredCount[to]! += 1;
      listOf.set(key, to);
      changed = true;
    }
  }
  return result;
}

export type NestedRowDrop =
  /** It stays under its parent; `order` is its list's stored order with it among its siblings. */
  | { readonly kind: "stay"; readonly order: readonly string[] }
  /** It lands outside its parent's group, so it stops nesting there. */
  | { readonly kind: "leave" };

/**
 * Where a nested row dropped in its own list goes. `shownOrder` is the list as shown with the row
 * in its new place. Landing after its parent and before the end of the parent's group keeps it
 * nested, at that place among its siblings; anywhere else, including above the parent, it leaves.
 */
export function planNestedRowDrop(input: {
  readonly key: string;
  readonly parentKey: string;
  readonly shownOrder: readonly string[];
  /** The list's stored order, which nesting keeps among siblings. */
  readonly storedOrder: readonly string[];
  /** Each shown row's parent in the list, or null at the top level. */
  readonly parentKeyOf: (key: string) => string | null;
}): NestedRowDrop {
  const { key, parentKey, shownOrder, storedOrder, parentKeyOf } = input;
  const at = shownOrder.indexOf(key);
  const parentAt = shownOrder.indexOf(parentKey);
  if (at === -1 || parentAt === -1 || at < parentAt) return { kind: "leave" };
  const inGroup = (candidate: string) => {
    const seen = new Set([candidate]);
    for (let up = parentKeyOf(candidate); up !== null && !seen.has(up); up = parentKeyOf(up)) {
      if (up === parentKey) return true;
      seen.add(up);
    }
    return false;
  };
  if (!shownOrder.slice(parentAt + 1, at).every(inGroup)) return { kind: "leave" };
  const stored = storedOrder.filter((candidate) => candidate !== key);
  const siblings = shownOrder.filter(
    (candidate) =>
      candidate !== key && parentKeyOf(candidate) === parentKey && stored.includes(candidate),
  );
  const before = siblings.filter((sibling) => shownOrder.indexOf(sibling) < at).length;
  if (siblings.length === 0 || !storedOrder.includes(key)) {
    return { kind: "stay", order: storedOrder };
  }
  const insertAt =
    before < siblings.length
      ? stored.indexOf(siblings[before]!)
      : stored.indexOf(siblings[before - 1]!) + 1;
  stored.splice(insertAt, 0, key);
  return { kind: "stay", order: stored };
}
