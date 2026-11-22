import {
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadShell,
  OrchestratorMcpFailure,
  type ThreadId,
} from "@t3tools/contracts";
import type { SidebarSection } from "@t3tools/contracts/settings";
import { planOrderKeyMove, sortUnkeyedRecentThenKeyed } from "@t3tools/shared/pinOrderKey";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import type { ActiveShellIndexEntry } from "../../../orchestration-v2/ProjectionStore.ts";

type PinnedEntry = Pick<ActiveShellIndexEntry, "id" | "pinnedAt" | "pinOrderKey" | "pinSectionId">;
/** One command a move needs; the caller gives each its command id. */
export type ArrangeWrite =
  | {
      readonly type: "thread.pin" | "thread.pin.reorder";
      readonly threadId: ThreadId;
      readonly orderKey: string;
      readonly sectionId?: string | null;
    }
  | {
      readonly type: "thread.active.reorder";
      readonly threadId: ThreadId;
      readonly orderKey: string;
    };

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** A pin in a section this environment no longer lists shows in plain Pinned, as clients show it. */
export function effectivePinSection(
  pinSectionId: string | null | undefined,
  sections: ReadonlyArray<SidebarSection>,
): string | null {
  return pinSectionId != null && sections.some((section) => section.id === pinSectionId)
    ? pinSectionId
    : null;
}

/** The pins of one list in sidebar order: keyed by key, then keyless ones. */
export function pinnedListOrder(
  index: ReadonlyArray<PinnedEntry>,
  sectionId: string | null,
  sections: ReadonlyArray<SidebarSection>,
): PinnedEntry[] {
  return index
    .filter(
      (entry) =>
        entry.pinnedAt != null && effectivePinSection(entry.pinSectionId, sections) === sectionId,
    )
    .toSorted((left, right) => {
      const leftKey = left.pinOrderKey;
      const rightKey = right.pinOrderKey;
      if (leftKey != null && rightKey == null) return -1;
      if (leftKey == null && rightKey != null) return 1;
      if (leftKey != null && rightKey != null && leftKey !== rightKey)
        return leftKey < rightKey ? -1 : 1;
      return left.id.localeCompare(right.id);
    });
}

type FolderThread = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "createdAt"
  | "latestUserMessageAt"
  | "latestUserAuthoredMessageAt"
  | "activeOrderKey"
  | "pinnedAt"
  | "settledOverride"
  | "snoozedUntil"
  | "archivedAt"
>;

/** A project folder's active threads in the order the project-folder sidebar shows them. */
export function folderOrder(
  threads: ReadonlyArray<FolderThread>,
  now: DateTime.Utc,
): FolderThread[] {
  const ms = (value: DateTime.Utc | null | undefined) =>
    value == null ? 0 : DateTime.toEpochMillis(value);
  return sortUnkeyedRecentThenKeyed(
    threads.filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.pinnedAt == null &&
        thread.settledOverride !== "settled" &&
        (thread.snoozedUntil == null || DateTime.isLessThanOrEqualTo(thread.snoozedUntil, now)),
    ),
    {
      key: (thread) => thread.activeOrderKey,
      recencyMs: (thread) =>
        Math.max(
          ms(thread.createdAt),
          ms(
            thread.latestUserAuthoredMessageAt === undefined
              ? thread.latestUserMessageAt
              : thread.latestUserAuthoredMessageAt,
          ),
        ),
      tiebreak: (left, right) => left.id.localeCompare(right.id),
    },
  );
}

const isOrchestratorMcpFailure = Schema.is(OrchestratorMcpFailure);

function insertBefore(
  ids: readonly ThreadId[],
  moved: ThreadId,
  beforeThreadId: ThreadId | null,
): ThreadId[] | OrchestratorMcpFailure {
  const rest = ids.filter((id) => id !== moved);
  if (beforeThreadId === null) return [...rest, moved];
  if (beforeThreadId === moved) return invalid("`beforeThreadId` is the thread being moved.");
  const index = rest.indexOf(beforeThreadId);
  if (index === -1) return invalid("`beforeThreadId` is not in the destination list.");
  return [...rest.slice(0, index), moved, ...rest.slice(index)];
}

/**
 * Commands that move a thread into a pinned list (plain Pinned or a section) before
 * `beforeThreadId`, or to its end. The moved thread's command comes first.
 */
export function planPinnedMove(input: {
  readonly thread: Pick<
    OrchestrationV2AppThread,
    "id" | "pinnedAt" | "pinOrderKey" | "pinSectionId"
  >;
  readonly sectionId: string | null;
  readonly beforeThreadId: ThreadId | null;
  readonly index: ReadonlyArray<PinnedEntry>;
  readonly sections: ReadonlyArray<SidebarSection>;
}): ArrangeWrite[] | OrchestratorMcpFailure {
  const { thread, sectionId } = input;
  const pinned = thread.pinnedAt != null;
  const sameList = pinned && effectivePinSection(thread.pinSectionId, input.sections) === sectionId;
  const list = pinnedListOrder(input.index, sectionId, input.sections);
  const order = insertBefore(
    list.map((entry) => entry.id),
    thread.id,
    input.beforeThreadId,
  );
  if (isOrchestratorMcpFailure(order)) return order;
  const keysById = new Map<string, string | null>(
    list.map((entry) => [entry.id, entry.pinOrderKey ?? null]),
  );
  keysById.set(thread.id, sameList ? (thread.pinOrderKey ?? null) : null);
  const assignments = planOrderKeyMove({ orderedIds: order, keysById, movedId: thread.id });
  const own = assignments.find((assignment) => assignment.id === thread.id);
  const others = assignments.filter((assignment) => assignment.id !== thread.id);
  const commands: ArrangeWrite[] = [];
  if (!pinned) {
    if (own === undefined) return invalid("The thread could not be placed.");
    commands.push({ type: "thread.pin", threadId: thread.id, orderKey: own.orderKey, sectionId });
  } else {
    // Written even when unchanged, so the caller always gets the move's sequence.
    const orderKey = own?.orderKey ?? thread.pinOrderKey;
    if (orderKey == null) return invalid("The thread could not be placed.");
    commands.push({
      type: "thread.pin.reorder",
      threadId: thread.id,
      orderKey,
      ...(sameList ? {} : { sectionId }),
    });
  }
  for (const { id, orderKey } of others) {
    commands.push({ type: "thread.pin.reorder", threadId: id as ThreadId, orderKey });
  }
  return commands;
}

/** Commands that place an active thread in its project folder before `beforeThreadId`. */
export function planFolderMove(input: {
  readonly threadId: ThreadId;
  readonly beforeThreadId: ThreadId | null;
  readonly folder: ReadonlyArray<FolderThread>;
}): ArrangeWrite[] | OrchestratorMcpFailure {
  const order = insertBefore(
    input.folder.map((thread) => thread.id),
    input.threadId,
    input.beforeThreadId,
  );
  if (isOrchestratorMcpFailure(order)) return order;
  const assignments = planOrderKeyMove({
    orderedIds: order,
    keysById: new Map(input.folder.map((thread) => [thread.id, thread.activeOrderKey ?? null])),
    movedId: input.threadId,
  });
  const current = input.folder.find((thread) => thread.id === input.threadId)?.activeOrderKey;
  const withMoved =
    assignments.some((assignment) => assignment.id === input.threadId) || current == null
      ? assignments
      : [...assignments, { id: input.threadId, orderKey: current }];
  return withMoved
    .toSorted((left, right) =>
      left.id === input.threadId ? -1 : right.id === input.threadId ? 1 : 0,
    )
    .map(({ id, orderKey }) => ({
      type: "thread.active.reorder" as const,
      threadId: id as ThreadId,
      orderKey,
    }));
}
