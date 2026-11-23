import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  isRuntimeModeAbove,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionScanError,
  AgentSessionSource,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  type RunId,
  ThreadId,
  TurnItemId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type OrchestrationV2AppThread,
  type OrchestrationV2AppThreadLineage,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import type { ClaudeDesktopLineage } from "./ClaudeDesktopSessions.ts";
import * as ProjectService from "./ProjectService.ts";

const isProjectionStoreThreadNotFoundError = Schema.is(
  ProjectionStore.ProjectionStoreThreadNotFoundError,
);

const IMPORT_EVENT_PREFIX = "agent-session-import:v2";
const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class AgentSessionUnresumableSessionError extends Schema.TaggedError<AgentSessionUnresumableSessionError>()(
  "AgentSessionUnresumableSessionError",
  {
    source: AgentSessionSource,
    providerSessionId: Schema.String,
  },
) {
  override get message(): string {
    return `Session '${this.providerSessionId}' from '${this.source}' cannot be resumed.`;
  }
}

class AgentSessionThreadProjectConflictError extends Schema.TaggedError<AgentSessionThreadProjectConflictError>()(
  "AgentSessionThreadProjectConflictError",
  {
    threadId: ThreadId,
    expectedProjectId: ProjectId,
    actualProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' belongs to project '${this.actualProjectId}', not '${this.expectedProjectId}'.`;
  }
}

class AgentSessionThreadModifiedError extends Schema.TaggedError<AgentSessionThreadModifiedError>()(
  "AgentSessionThreadModifiedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' already contains non-imported activity.`;
  }
}

// ACP imports read the history while holding the session-mutation lock, and an agent can
// leave session/resume or initialize unanswered. Longer than session/load's own deadline.
const NATIVE_HISTORY_READ_TIMEOUT = "2 minutes";

/**
 * Whether a thread bound to a native session still lacks its native history.
 * Once a turn has run, the native session also holds that turn's messages, so
 * its history can no longer be imported as run-less items.
 */
export function isNativeHistoryPending(input: {
  readonly historyOrigin: OrchestrationV2AppThread["historyOrigin"];
  readonly hasRun: boolean;
}): boolean {
  return input.historyOrigin !== "v1_import" && !input.hasRun;
}

/**
 * An imported Claude session the desktop app spawned from another nests under that session's
 * thread; a "btw" side chat stays inside it, as in the desktop app.
 */
function importedThreadLineage(input: {
  readonly threadId: ThreadId;
  readonly providerInstanceId: string;
  readonly claudeDesktop: ClaudeDesktopLineage | undefined;
}): OrchestrationV2AppThreadLineage {
  const own = { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId };
  if (input.claudeDesktop === undefined) return own;
  const parent = ThreadId.make(
    `import:${input.providerInstanceId}:${input.claudeDesktop.parentSessionId}`,
  );
  return input.claudeDesktop.sideChat
    ? { parentThreadId: parent, relationshipToParent: "fork", rootThreadId: parent, sideChat: true }
    : { ...own, spawnedBy: parent };
}

// The placement a person or agent chose is theirs: the import neither compares nor replaces it.
const sameLineage = (a: OrchestrationV2AppThreadLineage, b: OrchestrationV2AppThreadLineage) =>
  a.parentThreadId === b.parentThreadId &&
  a.relationshipToParent === b.relationshipToParent &&
  a.rootThreadId === b.rootThreadId &&
  (a.sideChat ?? false) === (b.sideChat ?? false) &&
  a.spawnedBy === b.spawnedBy;

function dateTime(value: string): DateTime.Utc {
  return DateTime.makeUnsafe(value);
}

interface ComparableMessage {
  readonly role: string;
  readonly text: string;
}

/** How an imported thread catches up with its session's transcript. */
export type ImportedHistoryRefresh =
  | { readonly kind: "unchanged" }
  /** `gap`: messages between the thread's last one and `messages` were cut from the transcript read. */
  | {
      readonly kind: "append";
      readonly messages: ReadonlyArray<AgentSessionScanner.AgentSessionThreadMessage>;
      readonly gap: boolean;
    }
  | { readonly kind: "diverged" };

// Enough trailing messages to place the thread's end in a truncated read without a chance match.
const REFRESH_OVERLAP_MESSAGES = 8;

/**
 * Plans the messages an imported thread lacks. A read of a long transcript keeps its first user
 * message and the latest history, so the thread's own last messages place it in that window; a
 * window that starts after them leaves a gap. Anything else that does not line up is divergence.
 */
export function planImportedHistoryRefresh(
  stored: ReadonlyArray<ComparableMessage & { readonly createdAt?: string | DateTime.Utc }>,
  incoming: Pick<AgentSessionScanner.AgentSessionThread, "messages" | "omittedMessageCount">,
): ImportedHistoryRefresh {
  const same = (left: ComparableMessage, right: ComparableMessage | undefined) =>
    right !== undefined && left.role === right.role && left.text === right.text;
  const messages = incoming.messages;
  if (
    stored.length <= messages.length &&
    stored.every((message, i) => same(message, messages[i]))
  ) {
    return stored.length === messages.length
      ? { kind: "unchanged" }
      : { kind: "append", messages: messages.slice(stored.length), gap: false };
  }
  if (incoming.omittedMessageCount === 0 || stored.length < 2 || !same(stored[0]!, messages[0])) {
    return { kind: "diverged" };
  }
  const tail = stored.slice(-Math.min(stored.length - 1, REFRESH_OVERLAP_MESSAGES));
  const ends: number[] = [];
  for (let end = tail.length; end < messages.length; end += 1) {
    if (tail.every((message, i) => same(message, messages[end - tail.length + 1 + i]))) {
      ends.push(end);
    }
  }
  if (ends.length === 1) {
    const rest = messages.slice(ends[0]! + 1);
    return rest.length === 0
      ? { kind: "unchanged" }
      : { kind: "append", messages: rest, gap: false };
  }
  if (ends.length > 1) return { kind: "diverged" };
  // No overlap: the window may have moved past everything the thread holds.
  const lastStored = stored.at(-1)?.createdAt;
  const lastStoredMs =
    lastStored === undefined
      ? Number.NaN
      : typeof lastStored === "string"
        ? Date.parse(lastStored)
        : DateTime.toEpochMillis(lastStored);
  const recent = messages.slice(1);
  if (
    recent.length > 0 &&
    Number.isFinite(lastStoredMs) &&
    recent.every((message) => Date.parse(message.createdAt) > lastStoredMs)
  ) {
    return { kind: "append", messages: recent, gap: true };
  }
  return { kind: "diverged" };
}

/** The next free history slot: imported message ids end in their zero-padded slot. */
function nextHistorySlot(threadId: ThreadId, messageIds: ReadonlyArray<string>): number {
  let next = messageIds.length;
  for (const id of messageIds) {
    if (!id.startsWith(`${threadId}:`)) continue;
    const slot = Number(id.slice(threadId.length + 1));
    if (Number.isInteger(slot) && slot >= next) next = slot + 1;
  }
  return next;
}

/** Why an import left a session alone. */
export type AgentSessionImportSkipReason =
  /** Unreadable, outside the project's folders, or past the scan's per-call budget. */
  | "not-importable"
  | "unresumable"
  | "other-project"
  /** Its thread has T3 runs or messages of its own. */
  | "t3-activity"
  /** Its transcript no longer starts with the thread's messages. */
  | "diverged"
  | "failed";

export interface AgentSessionImportReport {
  readonly imported: ReadonlyArray<ThreadId>;
  readonly refreshed: ReadonlyArray<ThreadId>;
  readonly unchangedCount: number;
  /** Earlier imports linked to the parent the Claude desktop app names. */
  readonly linked: ReadonlyArray<ThreadId>;
  readonly skipped: Partial<Record<AgentSessionImportSkipReason, number>>;
  readonly skippedCount: number;
}

export type HistoryMessage = Omit<AgentSessionScanner.AgentSessionThreadMessage, "role"> & {
  readonly role: AgentSessionScanner.AgentSessionThreadMessage["role"] | "reasoning";
};

function messageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: HistoryMessage;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ordinal = input.index + 1;
  const suffix = String(input.index).padStart(6, "0");
  const messageId = MessageId.make(`${input.threadId}:${suffix}`);
  const turnItemId = TurnItemId.make(
    `${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`,
  );
  const at = dateTime(input.message.createdAt);
  const common = {
    id: turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItemEvent = (payload: OrchestrationV2TurnItem): OrchestrationV2DomainEvent => ({
    id: EventId.make(turnItemId),
    type: "turn-item.updated",
    threadId: input.threadId,
    occurredAt: at,
    payload,
  });
  if (input.message.role === "reasoning") {
    return [
      turnItemEvent({ ...common, type: "reasoning", text: input.message.text, streaming: false }),
    ];
  }
  const message: OrchestrationV2ConversationMessage = {
    createdBy: input.message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: input.message.role,
    text: input.message.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: input.message.text,
          attachments: [],
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: input.message.text,
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${input.threadId}:${suffix}`),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: message,
    },
    turnItemEvent(turnItem),
  ];
}

const make = Effect.gen(function* () {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const ceiling = settingsService.managedPolicy?.limits?.maxRuntimeMode;
  // Links an earlier import to the parent the desktop app now names; never unlinks one.
  // Returns whether it changed (or, in a dry run, would change) the thread's lineage.
  const linkImportedThread = Effect.fn("AgentSessionImporter.linkImportedThread")(function* (
    threadId: ThreadId,
    providerInstanceId: string,
    claudeDesktop: ClaudeDesktopLineage | undefined,
    dryRun = false,
  ) {
    if (claudeDesktop === undefined) return false;
    const lineage = importedThreadLineage({ threadId, providerInstanceId, claudeDesktop });
    return yield* threadCommands
      .withLock(
        threadId,
        Effect.gen(function* () {
          const { thread } = yield* orchestrator.getThreadRecords(threadId, []);
          if (thread.historyOrigin !== "v1_import" || sameLineage(thread.lineage, lineage)) {
            return false;
          }
          if (dryRun) return true;
          const placed = thread.lineage.nestParentThreadId;
          yield* eventSink.write({
            events: [
              {
                id: yield* idAllocator.allocate.event({ threadId }),
                type: "thread.metadata-updated",
                threadId,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: yield* DateTime.now,
                payload: {
                  ...thread,
                  lineage:
                    placed === undefined ? lineage : { ...lineage, nestParentThreadId: placed },
                },
              },
            ],
          });
          return true;
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not link an imported agent session", { threadId, cause }).pipe(
            Effect.as(false),
          ),
        ),
      );
  });
  /**
   * Appends what an imported thread's session gained since: its new messages, title, and
   * activity time. Holds the thread lock from the read through the write, and leaves a thread
   * with T3 activity of its own, or whose transcript no longer lines up, alone.
   */
  const refreshImportedThread = Effect.fn("AgentSessionImporter.refreshImportedThread")(function* (
    threadId: ThreadId,
    thread: AgentSessionScanner.AgentSessionThread,
    dryRun: boolean,
  ) {
    return yield* threadCommands.withLock(
      threadId,
      Effect.gen(function* () {
        const records = yield* orchestrator.getThreadRecords(threadId, ["messages", "runs"]);
        const current = records.thread;
        if (
          current.historyOrigin !== "v1_import" ||
          records.runs.length > 0 ||
          records.messages.some((message) => message.runId !== null)
        ) {
          return "t3-activity" as const;
        }
        const plan = planImportedHistoryRefresh(records.messages, thread);
        if (plan.kind === "diverged") return "diverged" as const;
        if (plan.kind === "unchanged") return "unchanged" as const;
        if (dryRun) return "refreshed" as const;
        const firstSlot = nextHistorySlot(
          threadId,
          records.messages.map((message) => message.id),
        );
        const gapSlot = plan.gap ? firstSlot : null;
        const messageSlot = plan.gap ? firstSlot + 1 : firstSlot;
        const incomingUpdatedAt = dateTime(thread.updatedAt);
        const updatedAt = DateTime.isGreaterThan(incomingUpdatedAt, current.updatedAt)
          ? incomingUpdatedAt
          : current.updatedAt;
        const title = thread.title.trim() === "" ? current.title : thread.title;
        const gapAt = dateTime(plan.messages[0]!.createdAt);
        yield* eventSink.write({
          events: [
            ...(gapSlot === null
              ? []
              : [
                  {
                    id: EventId.make(`${IMPORT_EVENT_PREFIX}:history-gap:${threadId}:${gapSlot}`),
                    type: "turn-item.updated" as const,
                    threadId,
                    occurredAt: gapAt,
                    payload: {
                      id: TurnItemId.make(
                        `${IMPORT_EVENT_PREFIX}:history-gap:${threadId}:${gapSlot}`,
                      ),
                      threadId,
                      runId: null,
                      nodeId: null,
                      providerThreadId: null,
                      providerTurnId: null,
                      nativeItemRef: null,
                      parentItemId: null,
                      ordinal: gapSlot + 1,
                      status: "completed" as const,
                      title: null,
                      startedAt: gapAt,
                      completedAt: gapAt,
                      updatedAt: gapAt,
                      type: "system_notice" as const,
                      message:
                        "Some messages the session gained after its import were not imported here. The original session transcript is unchanged.",
                    },
                  },
                ]),
            ...plan.messages.flatMap((message, index) =>
              messageEvents({ threadId, index: messageSlot + index, message }),
            ),
            ...(title === current.title &&
            DateTime.toEpochMillis(updatedAt) === DateTime.toEpochMillis(current.updatedAt)
              ? []
              : [
                  {
                    id: yield* idAllocator.allocate.event({ threadId }),
                    type: "thread.metadata-updated" as const,
                    threadId,
                    providerInstanceId: current.providerInstanceId,
                    occurredAt: updatedAt,
                    payload: { ...current, title, updatedAt },
                  },
                ]),
          ],
        });
        return "refreshed" as const;
      }),
    );
  });
  /**
   * Imports a project's recent agent sessions, refreshes earlier imports that fell behind their
   * session, and links them to the parents the Claude desktop app names. A dry run reports the
   * same without writing anything.
   */
  const importAgentThreads = Effect.fn("importAgentThreadsV2")(function* (
    input: AgentSessionImportInput,
    options: {
      readonly dryRun?: boolean;
      readonly onlySources?: ReadonlyArray<"claudeAgent" | "codex">;
    } = {},
  ) {
    const dryRun = options.dryRun === true;
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (
      input.expectedWorkspaceRoot !== undefined &&
      normalizeProjectPathForComparison(project.workspaceRoot) !==
        normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
    ) {
      return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
    }
    // Imports run in full access, except under a policy ceiling: then in the project's default,
    // which the policy keeps under it, so imported threads never sit above the ceiling.
    const runtimeMode =
      ceiling === undefined
        ? DEFAULT_RUNTIME_MODE
        : yield* settingsService.getSettings.pipe(
            Effect.mapError(
              (cause) => new AgentSessionScanError({ operation: "read-settings", cause }),
            ),
            Effect.map((settings) => {
              const mode = resolveProjectSettings(settings, input.projectId, project).settings
                .defaultRuntimeMode;
              return isRuntimeModeAbove(mode, ceiling) ? ceiling : mode;
            }),
          );
    const runtimeRows = yield* runtimes
      .list()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    // The thread's project owns its transcripts: a linked worktree import records the worktree as cwd.
    const completedSources = (yield* Effect.forEach(runtimeRows, (runtime) => {
      const imported = AgentSessionScanner.decodeImportedTranscriptPayload(
        runtime.runtimePayload,
      ).pipe(Option.flatMapNullishOr((payload) => payload.importedTranscripts));
      if (Option.isNone(imported) || imported.value.length === 0) return Effect.succeed([]);
      return orchestrator.getThreadRecords(runtime.threadId, []).pipe(
        Effect.map(({ thread }) => (thread.projectId === input.projectId ? imported.value : [])),
        Effect.catch((cause) =>
          isProjectionStoreThreadNotFoundError(cause.cause)
            ? Effect.succeed([])
            : Effect.fail(new AgentSessionScanError({ operation: "read-projects", cause })),
        ),
      );
    })).flat();
    const outcomes = scanner.recentThreads(
      project.workspaceRoot,
      completedSources,
      options.onlySources,
    );
    const importedThreadIds = new Set<ThreadId>();
    const imported: ThreadId[] = [];
    const refreshed: ThreadId[] = [];
    const linked: ThreadId[] = [];
    const skipped: Partial<Record<AgentSessionImportSkipReason, number>> = {};
    let unchangedCount = 0;
    const skip = (reason: AgentSessionImportSkipReason) => {
      skipped[reason] = (skipped[reason] ?? 0) + 1;
    };
    const link = Effect.fn("AgentSessionImporter.link")(function* (
      threadId: ThreadId,
      providerInstanceId: string,
      claudeDesktop: ClaudeDesktopLineage | undefined,
    ) {
      if (yield* linkImportedThread(threadId, providerInstanceId, claudeDesktop, dryRun)) {
        linked.push(threadId);
      }
    });

    yield* Stream.runForEach(outcomes, (outcome) =>
      Effect.gen(function* () {
        if (outcome._tag === "Skipped") {
          skip("not-importable");
          return;
        }
        const source = outcome.source;
        const threadId = ThreadId.make(
          `import:${source.providerInstanceId}:${source.providerSessionId}`,
        );
        if (outcome._tag === "AlreadyImported") {
          importedThreadIds.add(threadId);
          unchangedCount += 1;
          yield* link(threadId, source.providerInstanceId, outcome.claudeDesktop);
          return;
        }
        if (outcome._tag === "Duplicate") {
          if (importedThreadIds.has(threadId) && !dryRun) {
            yield* runtimes.recordImportedTranscript({ threadId, source }).pipe(Effect.ignore);
          }
          return;
        }

        const result = yield* Effect.gen(function* () {
          const thread = outcome.thread;
          if (
            thread.source === "claudeAgent" &&
            !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
          ) {
            return yield* new AgentSessionUnresumableSessionError({
              source: thread.source,
              providerSessionId: thread.providerSessionId,
            });
          }
          const driver = ProviderDriverKind.make(thread.source);
          // Pi resumes by session file path; its session UUID only names the thread.
          const nativeThreadId =
            thread.source === "pi" ? source.filePath : thread.providerSessionId;
          const persistRuntime = runtimes.upsert(
            {
              threadId,
              providerName: driver,
              providerInstanceId: thread.providerInstanceId,
              adapterKey: driver,
              runtimeMode,
              status: "stopped",
              lastSeenAt: thread.updatedAt,
              resumeCursor:
                thread.source === "claudeAgent"
                  ? { threadId, resume: thread.providerSessionId }
                  : { threadId: nativeThreadId },
              runtimePayload: { cwd: outcome.worktree?.path ?? project.workspaceRoot },
            },
            { onConflict: "ignore" },
          );
          const existing = yield* Effect.option(
            orchestrator.getThreadRecords(threadId, ["messages"]),
          );
          if (Option.isSome(existing)) {
            if (existing.value.thread.projectId !== input.projectId) {
              return yield* new AgentSessionThreadProjectConflictError({
                threadId,
                expectedProjectId: input.projectId,
                actualProjectId: existing.value.thread.projectId,
              });
            }
            if (existing.value.thread.historyOrigin !== "v1_import") {
              return yield* new AgentSessionThreadModifiedError({ threadId });
            }
            // A transcript can change after the import. Its thread takes the messages it
            // gained, and the transcript is recorded only once the thread holds them all.
            const refresh = yield* refreshImportedThread(threadId, thread, dryRun);
            if (refresh === "t3-activity" || refresh === "diverged") return refresh;
            if (!dryRun) {
              yield* persistRuntime;
              yield* runtimes.recordImportedTranscript({ threadId, source });
            }
            yield* link(threadId, source.providerInstanceId, outcome.claudeDesktop);
            importedThreadIds.add(threadId);
            return refresh;
          }
          if (dryRun) return "imported" as const;

          const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL;
          const providerThreadId = idAllocator.derive.providerThread({
            driver,
            providerInstanceId: thread.providerInstanceId,
            nativeThreadId,
          });
          const createdAt = dateTime(thread.createdAt);
          const updatedAt = dateTime(thread.updatedAt);
          const appThread: OrchestrationV2AppThread = {
            createdBy: "system",
            creationSource: "server",
            id: threadId,
            projectId: input.projectId,
            title: thread.title.trim() === "" ? "Untitled thread" : thread.title,
            providerInstanceId: thread.providerInstanceId,
            modelSelection: { instanceId: thread.providerInstanceId, model },
            runtimeMode,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: outcome.worktree?.branch ?? null,
            worktreePath: outcome.worktree?.path ?? null,
            linkedPullRequest: null,
            branchPullRequest: null,
            activeProviderThreadId: providerThreadId,
            historyOrigin: "v1_import",
            lineage: importedThreadLineage({
              threadId,
              providerInstanceId: source.providerInstanceId,
              claudeDesktop: outcome.claudeDesktop,
            }),
            forkedFrom: null,
            createdAt,
            updatedAt,
            archivedAt: null,
            settledOverride: "settled",
            settledAt: updatedAt,
            unsettledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            pinnedAt: null,
            pinOrderKey: null,
            activeOrderKey: null,
            lastVisitedAt: null,
            deletedAt: null,
          };
          const providerThread: OrchestrationV2ProviderThread = {
            id: providerThreadId,
            driver,
            providerInstanceId: thread.providerInstanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver,
              nativeId: nativeThreadId,
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            createdAt,
            updatedAt,
          };

          const committed = yield* eventSink.write({
            unlessNativeThreadOwned: providerThread,
            events: [
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
                type: "thread.created",
                threadId,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: createdAt,
                payload: appThread,
              },
              ...(thread.omittedMessageCount > 0
                ? [
                    {
                      id: EventId.make(`${IMPORT_EVENT_PREFIX}:history-truncated:${threadId}`),
                      type: "turn-item.updated" as const,
                      threadId,
                      occurredAt: createdAt,
                      payload: {
                        id: TurnItemId.make(`${IMPORT_EVENT_PREFIX}:history-truncated:${threadId}`),
                        threadId,
                        runId: null,
                        nodeId: null,
                        providerThreadId: null,
                        providerTurnId: null,
                        nativeItemRef: null,
                        parentItemId: null,
                        ordinal: 0,
                        status: "completed" as const,
                        title: null,
                        startedAt: createdAt,
                        completedAt: createdAt,
                        updatedAt: createdAt,
                        type: "system_notice" as const,
                        message: `${thread.omittedMessageCount} earlier ${thread.omittedMessageCount === 1 ? "message was" : "messages were"} not imported. This thread keeps the first user message and the most recent history. The original session transcript is unchanged.`,
                      },
                    },
                  ]
                : []),
              ...thread.messages.flatMap((message, index) =>
                messageEvents({ threadId, index, message }),
              ),
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:provider-thread:${providerThreadId}`),
                type: "provider-thread.updated",
                threadId,
                driver,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: updatedAt,
                payload: providerThread,
              },
            ],
          });
          if (committed.length === 0) return null;
          yield* persistRuntime;
          yield* runtimes.recordImportedTranscript({ threadId, source });
          return "imported" as const;
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not import an agent session", {
              provider: outcome.thread.source,
              sessionId: outcome.thread.providerSessionId,
              cause,
            }).pipe(
              Effect.as<AgentSessionImportSkipReason>(
                cause._tag === "AgentSessionUnresumableSessionError"
                  ? "unresumable"
                  : cause._tag === "AgentSessionThreadProjectConflictError"
                    ? "other-project"
                    : cause._tag === "AgentSessionThreadModifiedError"
                      ? "t3-activity"
                      : "failed",
              ),
            ),
          ),
        );
        switch (result) {
          case null:
            return;
          case "imported":
            importedThreadIds.add(threadId);
            imported.push(threadId);
            return;
          case "refreshed":
            refreshed.push(threadId);
            return;
          case "unchanged":
            unchangedCount += 1;
            return;
          default:
            skip(result);
        }
      }),
    );

    return {
      imported,
      refreshed,
      unchangedCount,
      linked,
      skipped,
      skippedCount: Object.values(skipped).reduce((sum, count) => sum + count, 0),
    } satisfies AgentSessionImportReport;
  });

  const importRecentAgentThreads = Effect.fn("importRecentAgentThreadsV2")(function* (
    input: AgentSessionImportInput,
  ) {
    const report = yield* importAgentThreads(input);
    return {
      importedCount: report.imported.length,
      skippedCount: report.skippedCount,
      ...(report.refreshed.length === 0 ? {} : { refreshedCount: report.refreshed.length }),
    } satisfies AgentSessionImportResult;
  });

  const pendingHistoryThread = (threadId: ThreadId) =>
    Effect.map(orchestrator.getThreadRecords(threadId, ["providerThreads", "runs"]), (records) =>
      isNativeHistoryPending({
        historyOrigin: records.thread.historyOrigin,
        hasRun: records.runs.length > 0,
      })
        ? records
        : null,
    );

  /**
   * Writes `messages` into a thread with no runs as run-less history. The `v1_import` origin
   * keeps it in forks and marks the import done, so a later call does nothing.
   */
  const importHistory = Effect.fn("importHistoryV2")(function* (input: {
    readonly threadId: ThreadId;
    readonly messages: ReadonlyArray<HistoryMessage>;
  }) {
    // Thread commands write whole thread rows, so hold their lock from the
    // re-read through the write to keep both this marker and their changes.
    return yield* threadCommands.withLock(
      input.threadId,
      Effect.gen(function* () {
        const current = yield* pendingHistoryThread(input.threadId);
        if (current === null) return 0;
        yield* eventSink.write({
          events: [
            ...input.messages.flatMap((message, index) =>
              messageEvents({ threadId: input.threadId, index, message }),
            ),
            {
              id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${input.threadId}:native-history`),
              type: "thread.metadata-updated",
              threadId: input.threadId,
              providerInstanceId: current.thread.providerInstanceId,
              occurredAt: yield* DateTime.now,
              payload: { ...current.thread, historyOrigin: "v1_import" },
            },
          ],
        });
        return input.messages.length;
      }),
    );
  });

  /** Appends a completed notice to a thread's timeline, after its latest run's items. */
  const writeNotice = Effect.fn("writeNoticeV2")(function* (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId | null;
    readonly key: string;
    readonly title: string;
    readonly message: string;
  }) {
    const now = yield* DateTime.now;
    const id = `${input.key}:notice:${input.threadId}`;
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(id),
          type: "turn-item.updated",
          threadId: input.threadId,
          ...(input.runId === null ? {} : { runId: input.runId }),
          occurredAt: now,
          payload: {
            id: TurnItemId.make(id),
            threadId: input.threadId,
            runId: input.runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            // EventSink allocates the real position, after the existing items.
            ordinal: 0,
            status: "completed",
            title: input.title,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "system_notice",
            message: input.message,
          },
        },
      ],
    });
  });

  /**
   * Loading a native session replays its history only into the adapter's own
   * snapshot, so copy that snapshot into the thread as run-less history. A call
   * after a failed read repairs the thread and any later call does nothing.
   */
  const importNativeHistory = Effect.fn("importNativeHistoryV2")(function* (input: {
    readonly threadId: ThreadId;
    readonly workspaceRoot: string;
  }) {
    const pendingThread = pendingHistoryThread(input.threadId);
    const records = yield* pendingThread;
    if (records === null) return 0;
    const { thread, providerThreads } = records;
    const providerThread = providerThreads.find(
      (candidate) => candidate.appThreadId === input.threadId && candidate.nativeThreadRef !== null,
    );
    const nativeThreadId = providerThread?.nativeThreadRef?.nativeId;
    if (providerThread === undefined || nativeThreadId == null) return 0;
    const providerSessionId = yield* idAllocator.allocate.providerSession({
      providerInstanceId: providerThread.providerInstanceId,
      threadId: input.threadId,
    });
    // The registry admits this open against sign-in changes, like any other open.
    const adapter = yield* registry.get(thread.modelSelection.instanceId);
    const snapshot = yield* adapter
      .openSession({
        threadId: input.threadId,
        providerSessionId,
        modelSelection: thread.modelSelection,
        runtimePolicy: {
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          cwd: thread.worktreePath ?? input.workspaceRoot,
        },
        initialNativeThreadId: nativeThreadId,
        ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
          ? {}
          : {
              initialProviderItemIdentityVersion: providerThread.nativeMetadata.itemIdentityVersion,
            }),
      })
      .pipe(
        Effect.flatMap((session) => session.readThreadSnapshot({ providerThread })),
        Effect.timeout(NATIVE_HISTORY_READ_TIMEOUT),
        Effect.scoped,
      );
    const reasoningIds = new Set(snapshot.reasoningMessageIds);
    const messages = snapshot.messages.flatMap((message) =>
      (message.role === "user" || message.role === "assistant") && message.text.trim() !== ""
        ? [
            {
              role: reasoningIds.has(message.id) ? ("reasoning" as const) : message.role,
              text: message.text,
              createdAt: DateTime.formatIso(message.createdAt),
            },
          ]
        : [],
    );
    // Loading the session can take a while, and the thread is usable meanwhile.
    return yield* importHistory({ threadId: input.threadId, messages });
  });

  return {
    importAgentThreads,
    importRecentAgentThreads,
    importNativeHistory,
    importHistory,
    writeNotice,
  };
});

type AgentSessionImporterShape = Effect.Success<typeof make>;

export class AgentSessionImporter extends Context.Service<
  AgentSessionImporter,
  AgentSessionImporterShape
>()("t3/project/AgentSessionImporter") {}

export const layer = Layer.effect(AgentSessionImporter, make);
