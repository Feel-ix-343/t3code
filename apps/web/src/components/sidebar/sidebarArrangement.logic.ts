import type { SidebarSection as SidebarSectionDefinition } from "@t3tools/contracts/settings";
import { planOrderKeyMove } from "@t3tools/shared/pinOrderKey";

/** Where a row sits in the arranged (project folder) sidebar. */
export type SidebarArrangeContainer =
  | { readonly kind: "pinned"; readonly sectionId: string | null }
  | { readonly kind: "folder"; readonly projectKey: string };

export type SidebarArrangeItem =
  | { readonly kind: "thread"; readonly key: string }
  | {
      readonly kind: "boundary";
      readonly id: string;
      readonly container: SidebarArrangeContainer | null;
    };

export interface SidebarArrangeTarget {
  readonly container: SidebarArrangeContainer;
  /** Thread keys of the destination list, with the dragged row in its new place. */
  readonly order: readonly string[];
}

function sameArrangeContainer(
  left: SidebarArrangeContainer,
  right: SidebarArrangeContainer,
): boolean {
  return left.kind === "pinned"
    ? right.kind === "pinned" && left.sectionId === right.sectionId
    : right.kind === "folder" && left.projectKey === right.projectKey;
}

/** Rows above the first boundary are plain pins; a null boundary ends the arranged lists. */
export function resolveSidebarArrangeTarget(
  items: readonly SidebarArrangeItem[],
  activeKey: string,
  overId: string,
): SidebarArrangeTarget | null {
  const idOf = (item: SidebarArrangeItem) => (item.kind === "thread" ? item.key : item.id);
  const activeIndex = items.findIndex((item) => item.kind === "thread" && item.key === activeKey);
  const overIndex = items.findIndex((item) => idOf(item) === overId);
  if (activeIndex === -1 || overIndex === -1) return null;
  const moved = items.filter((_, index) => index !== activeIndex);
  moved.splice(overIndex, 0, items[activeIndex]!);
  let container: SidebarArrangeContainer | null = { kind: "pinned", sectionId: null };
  let start = 0;
  for (let index = overIndex - 1; index >= 0; index -= 1) {
    const item = moved[index]!;
    if (item.kind === "boundary") {
      container = item.container;
      start = index + 1;
      break;
    }
  }
  if (container === null) return null;
  const order: string[] = [];
  for (let index = start; index < moved.length; index += 1) {
    const item = moved[index]!;
    if (item.kind === "boundary") break;
    order.push(item.key);
  }
  return { container, order };
}

export interface SidebarArrangeThread {
  readonly key: string;
  readonly pinned: boolean;
  /** The section the thread shows in; an unknown section id reads as null. */
  readonly sectionId: string | null;
  /** Its project folder, or null while it is not an active thread. */
  readonly folderKey: string | null;
}

type KeyAssignment = { readonly id: string; readonly orderKey: string };

export type SidebarArrangePlan =
  | { readonly kind: "none" }
  | {
      /** Pin an unpinned thread into the list; `orderKey` places it. */
      readonly kind: "pin";
      readonly sectionId: string | null;
      readonly orderKey: string;
      readonly others: readonly KeyAssignment[];
    }
  | {
      /** Rekey pins; the moved thread's write also carries its new section. */
      readonly kind: "reorder-pinned";
      readonly sectionId: string | null;
      readonly assignments: readonly KeyAssignment[];
    }
  | {
      /** Order a folder by active keys, unpinning the moved thread first when it was pinned. */
      readonly kind: "reorder-folder";
      readonly unpin: boolean;
      readonly assignments: readonly KeyAssignment[];
    };

export function planSidebarArrangeDrop(input: {
  readonly thread: SidebarArrangeThread;
  readonly target: SidebarArrangeTarget;
  /** Current order of the thread's own list, to skip a drop that changes nothing. */
  readonly sourceOrder: readonly string[];
  readonly pinKeysById: ReadonlyMap<string, string | null | undefined>;
  readonly activeKeysById: ReadonlyMap<string, string | null | undefined>;
}): SidebarArrangePlan {
  const { thread, target } = input;
  const source: SidebarArrangeContainer | null = thread.pinned
    ? { kind: "pinned", sectionId: thread.sectionId }
    : thread.folderKey === null
      ? null
      : { kind: "folder", projectKey: thread.folderKey };
  const unchanged =
    source !== null &&
    sameArrangeContainer(source, target.container) &&
    target.order.length === input.sourceOrder.length &&
    target.order.every((key, index) => input.sourceOrder[index] === key);
  if (unchanged) return { kind: "none" };
  if (target.container.kind === "folder") {
    // A thread's project decides its folder, so it can only be placed in its own.
    if (target.container.projectKey !== thread.folderKey) return { kind: "none" };
    return {
      kind: "reorder-folder",
      unpin: thread.pinned,
      assignments: planOrderKeyMove({
        orderedIds: target.order,
        keysById: input.activeKeysById,
        movedId: thread.key,
      }),
    };
  }
  const { sectionId } = target.container;
  const assignments = planOrderKeyMove({
    orderedIds: target.order,
    keysById: thread.pinned
      ? input.pinKeysById
      : new Map([...input.pinKeysById].filter(([id]) => id !== thread.key)),
    movedId: thread.key,
  });
  const own = assignments.find((assignment) => assignment.id === thread.key);
  const others = assignments.filter((assignment) => assignment.id !== thread.key);
  if (!thread.pinned) {
    const orderKey = own?.orderKey;
    return orderKey === undefined ? { kind: "none" } : { kind: "pin", sectionId, orderKey, others };
  }
  const currentKey = input.pinKeysById.get(thread.key);
  // Moving sections must write the moved thread even when its key can stay.
  const moved =
    own ??
    (thread.sectionId !== sectionId && currentKey != null
      ? { id: thread.key, orderKey: currentKey }
      : undefined);
  if (moved === undefined && others.length === 0) return { kind: "none" };
  return {
    kind: "reorder-pinned",
    sectionId,
    assignments: moved === undefined ? others : [moved, ...others],
  };
}

/** Sections across environments, by id, in the order of the first environment listing each. */
export function mergeSidebarSections(
  lists: ReadonlyArray<ReadonlyArray<SidebarSectionDefinition>>,
): SidebarSectionDefinition[] {
  const seen = new Set<string>();
  const merged: SidebarSectionDefinition[] = [];
  for (const list of lists) {
    for (const section of list) {
      if (seen.has(section.id)) continue;
      seen.add(section.id);
      merged.push(section);
    }
  }
  return merged;
}

export function moveSidebarSection(
  sections: ReadonlyArray<SidebarSectionDefinition>,
  sectionId: string,
  beforeSectionId: string | null,
): SidebarSectionDefinition[] {
  const moving = sections.find((section) => section.id === sectionId);
  if (moving === undefined) return [...sections];
  const rest = sections.filter((section) => section.id !== sectionId);
  const index =
    beforeSectionId === null ? -1 : rest.findIndex((section) => section.id === beforeSectionId);
  rest.splice(index === -1 ? rest.length : index, 0, moving);
  return rest;
}
