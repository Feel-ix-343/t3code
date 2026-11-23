import {
  isListedThreadLineage,
  OrchestratorMcpFailure,
  threadNestParentId,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type { SidebarSection } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import type { ActiveShellIndexEntry } from "../../../orchestration-v2/ProjectionStore.ts";
import * as AgentSessionImporter from "../../../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../../../project/AgentSessionScanner.ts";
import type { ClaudeDesktopOrganization } from "../../../project/ClaudeDesktopSessions.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { dispatchFailure, newCommandId, unavailable } from "../../threadAccess.ts";
import { effectivePinSection, planPinnedMove } from "./sidebarArrangement.ts";

const CLAUDE_PROVIDER = "claudeAgent";
const SECTION_TITLE_MAX_LENGTH = 64;

/** The Claude Code session an imported thread holds: ids are `import:<instance>:<session>`. */
export function importedClaudeSessionId(threadId: string): string | null {
  const match = /^import:([^:]+):(.+)$/.exec(threadId);
  return match === null || !match[1]!.startsWith(CLAUDE_PROVIDER) ? null : match[2]!;
}

const sectionKey = (title: string) => title.trim().toLowerCase();

type PlacementThread = Pick<ActiveShellIndexEntry, "id" | "pinnedAt" | "pinSectionId">;

export interface ClaudeOrganizationPlan {
  /** Titles of the T3 sections to create, in the desktop app's order. */
  readonly createSections: ReadonlyArray<string>;
  /** Threads to pin into the section with `sectionTitle`. */
  readonly placements: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly sectionTitle: string;
    /** The T3 list it leaves: a section title, "Pinned", or null when it was not pinned. */
    readonly from: string | null;
  }>;
  /** Threads to pin in plain Pinned, in the desktop app's pinned order. */
  readonly pins: ReadonlyArray<ThreadId>;
}

/**
 * Mirrors the desktop app's sections and stars onto imported threads. A T3 section is matched by
 * title, and missing ones are created; none is renamed or removed. A thread moves only into the
 * section the desktop app assigns it, so one the user placed in T3 stays unless the app assigns
 * it elsewhere. A starred thread that is not pinned yet is pinned; nothing is unpinned.
 */
export function planClaudeOrganization(input: {
  readonly organization: ClaudeDesktopOrganization;
  readonly sections: ReadonlyArray<SidebarSection>;
  readonly threads: ReadonlyArray<PlacementThread>;
  readonly applySections: boolean;
  readonly applyPins: boolean;
}): ClaudeOrganizationPlan {
  const sessionThreads = new Map<string, PlacementThread>();
  for (const thread of input.threads) {
    const sessionId = importedClaudeSessionId(thread.id);
    if (sessionId !== null && !sessionThreads.has(sessionId)) sessionThreads.set(sessionId, thread);
  }
  const existing = new Map(input.sections.map((section) => [sectionKey(section.title), section]));
  const titleOf = (id: string) =>
    input.organization.sections
      .find((section) => section.id === id)
      ?.name.slice(0, SECTION_TITLE_MAX_LENGTH)
      .trim();

  const createSections: string[] = [];
  const placements: Array<ClaudeOrganizationPlan["placements"][number]> = [];
  const placed = new Set<ThreadId>();
  if (input.applySections) {
    const assigned = new Map<string, PlacementThread[]>();
    for (const [sessionId, sectionId] of input.organization.sectionBySession) {
      const thread = sessionThreads.get(sessionId);
      const title = titleOf(sectionId);
      if (thread === undefined || title === undefined || title === "") continue;
      assigned.set(title, [...(assigned.get(title) ?? []), thread]);
    }
    // Sections only for the desktop app's sections that hold an imported thread.
    for (const { id } of input.organization.sections) {
      const title = titleOf(id);
      if (title === undefined || !assigned.has(title)) continue;
      if (!existing.has(sectionKey(title)) && !createSections.includes(title)) {
        createSections.push(title);
      }
    }
    for (const [title, threads] of assigned) {
      const target = existing.get(sectionKey(title));
      for (const thread of threads) {
        const current =
          thread.pinnedAt == null
            ? undefined
            : effectivePinSection(thread.pinSectionId, input.sections);
        if (target !== undefined && current === target.id) continue;
        const from =
          current === undefined
            ? null
            : current === null
              ? "Pinned"
              : (input.sections.find((section) => section.id === current)?.title ?? "Pinned");
        placements.push({ threadId: thread.id, sectionTitle: title, from });
        placed.add(thread.id);
      }
    }
  }
  const pins = input.applyPins
    ? input.organization.starred.flatMap((sessionId) => {
        const thread = sessionThreads.get(sessionId);
        return thread === undefined || thread.pinnedAt != null || placed.has(thread.id)
          ? []
          : [thread.id];
      })
    : [];
  return { createSections, placements, pins };
}

type FollowerThread = Pick<
  ActiveShellIndexEntry,
  "id" | "lineage" | "pinnedAt" | "pinSectionId" | "settledOverride"
>;

/**
 * A nested thread shows under its parent only in the same list, so each child whose parent is
 * pinned into a section it is not in joins that section, deepest last so grandchildren follow.
 * Side chats, settled threads, threads the user unnested, and threads the desktop app assigns a
 * section of its own stay put. `threads` is the sidebar after the organization plan.
 */
function planNestedFollowers(input: {
  readonly threads: ReadonlyArray<FollowerThread>;
  /** The threads the sync may move. */
  readonly candidateIds: ReadonlySet<ThreadId>;
  /** Threads the desktop app places in a section itself. */
  readonly assignedIds: ReadonlySet<ThreadId>;
  readonly sections: ReadonlyArray<SidebarSection>;
}): ReadonlyArray<{ threadId: ThreadId; parentThreadId: ThreadId; sectionId: string }> {
  const sectionOf = new Map<ThreadId, string | null>();
  const byId = new Map(input.threads.map((thread) => [thread.id, thread] as const));
  for (const thread of input.threads) {
    sectionOf.set(
      thread.id,
      thread.pinnedAt == null ? null : effectivePinSection(thread.pinSectionId, input.sections),
    );
  }
  const followers: Array<{ threadId: ThreadId; parentThreadId: ThreadId; sectionId: string }> = [];
  // Each pass settles one more generation; a cycle stops when nothing changes.
  for (let changed = true; changed;) {
    changed = false;
    for (const thread of input.threads) {
      if (
        !input.candidateIds.has(thread.id) ||
        input.assignedIds.has(thread.id) ||
        !isListedThreadLineage(thread.lineage) ||
        thread.settledOverride === "settled"
      )
        continue;
      const parentId = threadNestParentId(thread.lineage);
      if (parentId === null || parentId === thread.id || !byId.has(parentId)) continue;
      const sectionId = sectionOf.get(parentId) ?? null;
      if (sectionId === null || sectionOf.get(thread.id) === sectionId) continue;
      sectionOf.set(thread.id, sectionId);
      const existing = followers.findIndex((follower) => follower.threadId === thread.id);
      if (existing !== -1) followers.splice(existing, 1);
      followers.push({ threadId: thread.id, parentThreadId: parentId, sectionId });
      changed = true;
    }
  }
  return followers;
}

export interface ClaudeSessionSyncInput {
  readonly projectId?: ProjectId | undefined;
  readonly dryRun?: boolean | undefined;
  readonly applySections?: boolean | undefined;
  readonly applyPins?: boolean | undefined;
}

const mcpFailure = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/**
 * Imports and refreshes the Claude Code sessions of one project or all of them, then mirrors the
 * Claude desktop app's sections and stars. A dry run reports the same without writing.
 */
export const syncClaudeSessions = Effect.fn("mcp.syncClaudeSessions")(function* (
  input: ClaudeSessionSyncInput,
) {
  const dryRun = input.dryRun === true;
  const projectService = yield* ProjectService.ProjectService;
  const importer = yield* AgentSessionImporter.AgentSessionImporter;
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;

  const projects =
    input.projectId === undefined
      ? yield* Effect.gen(function* () {
          const all: Array<{ id: ProjectId; title: string }> = [];
          for (let cursor: number | null = 0; cursor !== null;) {
            const page: {
              readonly projects: ReadonlyArray<{ id: ProjectId; title: string }>;
              readonly nextCursor: number | null;
            } = yield* projectService
              .listPage({ cursor, limit: 100 })
              .pipe(Effect.mapError(unavailable));
            all.push(...page.projects);
            cursor = page.nextCursor;
          }
          return all;
        })
      : [
          yield* projectService.getById(input.projectId).pipe(
            Effect.mapError(unavailable),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(mcpFailure("No project has that `projectId`.")),
                onSome: Effect.succeed,
              }),
            ),
          ),
        ];

  // Sessions started since the last scan are only seen after a fresh collection.
  yield* scanner.invalidateCandidates;
  const projectReports = yield* Effect.forEach(projects, (project) =>
    importer
      .importAgentThreads({ projectId: project.id }, { dryRun, onlySources: [CLAUDE_PROVIDER] })
      .pipe(
        Effect.map((report) => ({
          projectId: project.id,
          title: project.title,
          imported: report.imported.length,
          refreshed: report.refreshed.length,
          unchanged: report.unchangedCount,
          nested: report.linked.length,
          skipped: report.skipped,
          importedThreadIds: report.imported,
          refreshedThreadIds: report.refreshed,
        })),
        Effect.catch((error) =>
          Effect.succeed({
            projectId: project.id,
            title: project.title,
            imported: 0,
            refreshed: 0,
            unchanged: 0,
            nested: 0,
            skipped: {},
            importedThreadIds: [] as ReadonlyArray<ThreadId>,
            refreshedThreadIds: [] as ReadonlyArray<ThreadId>,
            error: error.message,
          }),
        ),
      ),
  );

  const organization = yield* scanner.claudeDesktopOrganization;
  const { sidebarSections: sections } = yield* settings.getSettings.pipe(
    Effect.mapError(unavailable),
  );
  const projectIds = new Set<string>(projects.map((project) => project.id));
  const fullIndex = yield* threads.listActiveShellIndex().pipe(Effect.mapError(unavailable));
  const scope = fullIndex.filter(
    (entry) =>
      projectIds.has(entry.projectId) &&
      isListedThreadLineage(entry.lineage) &&
      importedClaudeSessionId(entry.id) !== null,
  );
  // A dry run has not created its new threads; they would arrive unpinned.
  const planned = dryRun
    ? [
        ...scope,
        ...projectReports.flatMap((report) =>
          report.importedThreadIds.map((id) => ({ id, pinnedAt: null, pinSectionId: null })),
        ),
      ]
    : scope;
  const plan = planClaudeOrganization({
    organization,
    sections,
    threads: planned,
    applySections: input.applySections !== false,
    applyPins: input.applyPins !== false,
  });

  let sectionIdByTitle = new Map(
    sections.map((section) => [sectionKey(section.title), section.id]),
  );
  // Sections the plan creates get stand-in ids until they exist.
  const plannedSections: SidebarSection[] = [
    ...sections,
    ...plan.createSections.map((title) => ({ id: `planned:${sectionKey(title)}`, title })),
  ];
  const plannedSectionId = (title: string) =>
    plannedSections.find((section) => sectionKey(section.title) === sectionKey(title))?.id ?? null;
  const pinnedNow = DateTime.makeUnsafe(0);
  const afterPlan = new Map<ThreadId, FollowerThread>(
    fullIndex.map((entry) => [entry.id, entry] as const),
  );
  for (const placement of plan.placements) {
    const entry = afterPlan.get(placement.threadId);
    if (entry !== undefined)
      afterPlan.set(entry.id, {
        ...entry,
        pinnedAt: entry.pinnedAt ?? pinnedNow,
        pinSectionId: plannedSectionId(placement.sectionTitle),
      });
  }
  for (const threadId of plan.pins) {
    const entry = afterPlan.get(threadId);
    if (entry !== undefined)
      afterPlan.set(entry.id, {
        ...entry,
        pinnedAt: entry.pinnedAt ?? pinnedNow,
        pinSectionId: null,
      });
  }
  const sessionIdsAssigned = new Set(organization.sectionBySession.keys());
  const followers =
    input.applySections === false
      ? []
      : planNestedFollowers({
          threads: [...afterPlan.values()],
          candidateIds: new Set(scope.map((entry) => entry.id)),
          assignedIds: new Set(
            scope.flatMap((entry) => {
              const sessionId = importedClaudeSessionId(entry.id);
              return sessionId !== null && sessionIdsAssigned.has(sessionId) ? [entry.id] : [];
            }),
          ),
          sections: plannedSections,
        });
  if (!dryRun) {
    if (plan.createSections.length > 0) {
      const random = yield* SecureRandom.SecureRandom;
      const created: SidebarSection[] = [];
      for (const title of plan.createSections) {
        created.push({ id: `section-${yield* random.uuidV4()}`, title });
      }
      const { sidebarSections } = yield* settings
        .updateSettings({ sidebarSections: [...sections, ...created] })
        .pipe(Effect.mapError((error) => mcpFailure(error.message)));
      sectionIdByTitle = new Map(
        sidebarSections.map((section) => [sectionKey(section.title), section.id]),
      );
    }
    const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
    // Each move rekeys its destination list, so plan it against a fresh index.
    const place = Effect.fn("mcp.syncClaudeSessions.place")(function* (
      threadId: ThreadId,
      sectionId: string | null,
    ) {
      const index = yield* threads.listActiveShellIndex().pipe(Effect.mapError(unavailable));
      const thread = index.find((entry) => entry.id === threadId);
      if (thread === undefined) return;
      const writes = planPinnedMove({
        thread,
        sectionId,
        beforeThreadId: null,
        index,
        sections: current.sidebarSections,
      });
      if (!Array.isArray(writes)) return yield* writes as OrchestratorMcpFailure;
      for (const write of writes) {
        if (write.type === "thread.active.reorder") continue;
        yield* threads
          .dispatch({
            type: write.type,
            commandId: yield* newCommandId(),
            threadId: write.threadId,
            orderKey: write.orderKey,
            ...(write.sectionId === undefined ? {} : { sectionId: write.sectionId }),
          })
          .pipe(Effect.mapError(dispatchFailure));
      }
    });
    for (const placement of plan.placements) {
      const sectionId = sectionIdByTitle.get(sectionKey(placement.sectionTitle));
      if (sectionId !== undefined) yield* place(placement.threadId, sectionId);
    }
    for (const threadId of plan.pins) yield* place(threadId, null);
    for (const follower of followers) {
      const title = plannedSections.find((section) => section.id === follower.sectionId)?.title;
      const sectionId = title === undefined ? undefined : sectionIdByTitle.get(sectionKey(title));
      if (sectionId !== undefined) yield* place(follower.threadId, sectionId);
    }
  }

  const titles = yield* threads
    .getThreadTitles([
      ...plan.placements.map((placement) => placement.threadId),
      ...plan.pins,
      ...followers.map((follower) => follower.threadId),
    ])
    .pipe(Effect.orElseSucceed((): Record<ThreadId, string> => ({})));
  const titled = (threadId: ThreadId) => ({
    threadId,
    ...(titles[threadId] === undefined ? {} : { title: titles[threadId] }),
  });
  const skipped: Record<string, number> = {};
  for (const report of projectReports) {
    for (const [reason, count] of Object.entries(report.skipped)) {
      skipped[reason] = (skipped[reason] ?? 0) + (count ?? 0);
    }
  }
  return {
    dryRun,
    projects: projectReports.map(
      ({ importedThreadIds: _imported, refreshedThreadIds: _refreshed, ...report }) => report,
    ),
    totals: {
      imported: projectReports.reduce((sum, report) => sum + report.imported, 0),
      refreshed: projectReports.reduce((sum, report) => sum + report.refreshed, 0),
      unchanged: projectReports.reduce((sum, report) => sum + report.unchanged, 0),
      nested: projectReports.reduce((sum, report) => sum + report.nested, 0),
      skipped,
    },
    refreshedThreadIds: projectReports.flatMap((report) => report.refreshedThreadIds),
    sectionsCreated: plan.createSections,
    moved: plan.placements.map((placement) => ({
      ...titled(placement.threadId),
      from: placement.from,
      to: placement.sectionTitle,
    })),
    pinned: plan.pins.map(titled),
    keptWithParent: followers.map((follower) => ({
      ...titled(follower.threadId),
      parentThreadId: follower.parentThreadId,
      to: plannedSections.find((section) => section.id === follower.sectionId)?.title ?? "",
    })),
    claudeDesktop: {
      sections: organization.sections.length,
      assignedSessions: organization.sectionBySession.size,
      starredSessions: organization.starred.length,
    },
  };
});
