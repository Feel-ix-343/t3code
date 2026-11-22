import type { OrchestrationV2AppThreadLineage, ThreadId } from "@t3tools/contracts";

/** The thread another one was launched or forked from, which the sidebar nests it under. */
export function sidebarNestParentId(lineage: OrchestrationV2AppThreadLineage): ThreadId | null {
  if (lineage.spawnedBy !== undefined) return lineage.spawnedBy;
  if (lineage.relationshipToParent === "fork" && lineage.sideChat !== true) {
    return lineage.parentThreadId;
  }
  return null;
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
