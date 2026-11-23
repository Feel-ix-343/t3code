import * as AssetSigner from "../../assets/AssetSigner.ts";
import * as DocumentText from "../../provider/DocumentText.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ChatImageAttachment,
  CommandId,
  EnvironmentId,
  NodeId,
  OrchestratorMcpThreadReadResult,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ScheduledTaskError,
  ScheduledTask,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { pinOrderKeyBetween } from "@t3tools/shared/pinOrderKey";
import * as DateTime from "effect/DateTime";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpAttachmentInput } from "./attachment/input.ts";
import { McpSchema, McpServer } from "effect/ai";
import { FetchHttpClient } from "effect/http";

import {
  OrchestratorCommandRejectedError,
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  OrchestratorProviderSelectionBusyError,
} from "../../orchestration-v2/Orchestrator.ts";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import type * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadSearch from "../../orchestration-v2/ThreadSearch.ts";
import * as PreviewBrowser from "../../preview/PreviewBrowser.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as AgentSessionImporter from "../../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../../project/AgentSessionScanner.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as RemoteDelegation from "../../peer/RemoteDelegation.ts";
import * as ThreadMove from "../../peer/ThreadMove.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as McpHttpServer from "../McpHttpServer.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../McpToolAccess.testkit.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import { dispatchFailure } from "../threadAccess.ts";
import * as EnvironmentHandlers from "./environment/handlers.ts";
import * as AttachmentHandlers from "./attachment/handlers.ts";
import { ThreadToolkit } from "./thread/tools.ts";
import * as PeerForwarding from "../../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../../peer/PeerLinks.ts";

const layerOrchestratorToolkit = McpHttpServer.layerOrchestratorToolkit.pipe(
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";

const decodeMcpAttachmentInput = Schema.decodeUnknownEffect(McpAttachmentInput);
const decodeThreadReadResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);
const decodeThreadSearchResult = Schema.decodeUnknownEffect(
  ThreadToolkit.tools.t3_thread_search.successSchema,
);

const layerNoSessionSync = Layer.mergeAll(
  Layer.mock(AgentSessionImporter.AgentSessionImporter)({}),
  Layer.mock(AgentSessionScanner.AgentSessionScanner)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(ThreadMove.ThreadMove)({}),
);

const threadToolkitWithSettings = (
  settings: Parameters<typeof ServerSettings.ServerSettingsService.layerTest>[0] = {},
  sessions: {
    readonly importer?: Partial<AgentSessionImporter.AgentSessionImporter["Service"]>;
    readonly scanner?: Partial<AgentSessionScanner.AgentSessionScanner["Service"]>;
    readonly projects?: Partial<ProjectService.ProjectService["Service"]>;
  } = {},
) =>
  McpHttpServer.layerThreadToolkit.pipe(
    Layer.provide(Layer.mock(AgentSessionImporter.AgentSessionImporter)(sessions.importer ?? {})),
    Layer.provide(Layer.mock(AgentSessionScanner.AgentSessionScanner)(sessions.scanner ?? {})),
    Layer.provide(Layer.mock(ProjectService.ProjectService)(sessions.projects ?? {})),
    Layer.provide(Layer.mock(ThreadMove.ThreadMove)({})),
    Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
    Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
    Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
    Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
    Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
    Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest(settings)),
  );
const layerThreadToolkit = threadToolkitWithSettings();

const threadId = ThreadId.make("mcp-core-thread");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("mcp-core-environment"),
  requestNamespace: "mcp-core-session",
  thread: {
    threadId,
    providerSessionId: "mcp-core-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-core", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-core", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect("checks capability through the production registration", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    expect(server.tools.some(({ tool }) => tool.name === "t3_thread_organize")).toBe(true);
    const result = yield* server
      .callTool({ name: "t3_thread_organize", arguments: { action: "pin" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...scope,
          capabilities: new Set<never>(),
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(declaredFailure(result)).toMatchObject({ code: "capability_denied" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  }).pipe(
    Effect.provide(
      layerThreadToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
      ),
    ),
  ),
);

it.effect("an answered question reports already answered instead of not found", () => {
  const shell = McpToolAccessTestkit.liveThreadShell(threadId);
  const requestId = RuntimeRequestId.make("answered-question");
  const projection = McpToolAccessTestkit.idleThreadProjection(shell);
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const respond = (id: string) =>
      server
        .callTool({
          name: "t3_pending_request",
          arguments: { action: "respond", requestId: id, answers: { size: "large" } },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    expect(declaredFailure(yield* respond(requestId))).toMatchObject({
      code: "invalid_request",
      message: "The user-input request was already answered.",
    });
    expect(declaredFailure(yield* respond("missing-question"))).toMatchObject({
      code: "invalid_request",
      message: "The pending user-input request was not found.",
    });
  }).pipe(
    Effect.provide(
      layerThreadToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () => Effect.succeed(shell),
            getProjectThreadRecords: () =>
              Effect.succeed({
                ...projection,
                runtimeRequests: [
                  {
                    id: requestId,
                    nodeId: NodeId.make("root"),
                    providerTurnId: null,
                    nativeRequestRef: null,
                    kind: "user_input",
                    status: "resolved",
                    responseCapability: { type: "message" },
                    createdAt: shell.createdAt,
                    resolvedAt: shell.updatedAt,
                    answers: { size: "large" },
                  },
                ],
                turnItems: [
                  {
                    id: TurnItemId.make("answered-question-item"),
                    threadId,
                    runId: null,
                    nodeId: null,
                    providerThreadId: null,
                    providerTurnId: null,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: 0,
                    status: "completed",
                    title: null,
                    startedAt: shell.createdAt,
                    completedAt: shell.updatedAt,
                    updatedAt: shell.updatedAt,
                    type: "user_input_request",
                    requestId,
                    questions: [],
                  },
                ],
              }),
            dispatch: () => Effect.die("an answered question must not dispatch again"),
          }),
        ),
      ),
    ),
  );
});

it.effect("a pending question read keeps option previews", () => {
  const shell = McpToolAccessTestkit.liveThreadShell(threadId);
  const requestId = RuntimeRequestId.make("previewed-question");
  const projection = McpToolAccessTestkit.idleThreadProjection(shell);
  const questions = [
    {
      id: "post",
      header: "Review",
      question: "Post it?",
      options: [{ label: "Post", description: "Publish the draft", preview: "Full proposed text" }],
    },
  ];
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "t3_pending_request", arguments: { action: "read", requestId } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.structuredContent).toEqual({ requestId, questions });
  }).pipe(
    Effect.provide(
      layerThreadToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () => Effect.succeed(shell),
            getProjectThreadRecords: () =>
              Effect.succeed({
                ...projection,
                runtimeRequests: [
                  {
                    id: requestId,
                    nodeId: NodeId.make("root"),
                    providerTurnId: null,
                    nativeRequestRef: null,
                    kind: "user_input",
                    status: "pending",
                    responseCapability: { type: "message" },
                    createdAt: shell.createdAt,
                    resolvedAt: null,
                  },
                ],
                turnItems: [
                  {
                    id: TurnItemId.make("previewed-question-item"),
                    threadId,
                    runId: null,
                    nodeId: null,
                    providerThreadId: null,
                    providerTurnId: null,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: 0,
                    status: "running",
                    title: null,
                    startedAt: shell.createdAt,
                    completedAt: null,
                    updatedAt: shell.updatedAt,
                    type: "user_input_request",
                    requestId,
                    questions,
                  },
                ],
              }),
          }),
        ),
      ),
    ),
  );
});

it("bounds public command rejections and redacts internal dispatch causes", () => {
  const command = { commandId: CommandId.make("mcp-core-command"), commandType: "thread.settle" };
  expect(
    dispatchFailure(new OrchestratorDispatchError({ ...command, cause: "🙂".repeat(1001) }))
      .message,
  ).toBe("🙂".repeat(1000));
  expect(
    dispatchFailure(
      new OrchestratorCommandRejectedError({ ...command, cause: "Run is not queued." }),
    ).message,
  ).toBe("Run is not queued.");
  const busy = new OrchestratorProviderSelectionBusyError({
    commandId: command.commandId,
    threadId,
  });
  expect(dispatchFailure(busy)).toMatchObject({ code: "invalid_request", message: busy.message });
  for (const cause of [
    undefined,
    "",
    new Error("private-storage-path"),
    { message: "private-storage-path" },
  ]) {
    expect(dispatchFailure(new OrchestratorDispatchError({ ...command, cause }))).toMatchObject({
      code: "orchestration_error",
      message: "The operation could not be completed.",
    });
    expect(
      dispatchFailure(new OrchestratorCommandRejectedError({ ...command, cause })),
    ).toMatchObject({
      code: "orchestration_error",
      message: "The operation could not be completed.",
    });
  }
  expect(
    dispatchFailure(new OrchestratorProjectionError({ threadId, cause: "private-storage-path" })),
  ).toMatchObject({
    code: "orchestration_error",
    message: "The operation could not be completed.",
  });
});

const fullAccessThreadId = ThreadId.make("mcp-core-full-access-thread");

it.effect("returns an HTML render reference that Codex and Claude tool rows both carry", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: "html_render",
        arguments: { html: "<p>Revenue</p>", title: "Revenue", height: 240 },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    const reference = htmlRenderFromToolItem({
      toolName: "t3-code.html_render",
      output: result.structuredContent,
    });
    expect(reference).toMatchObject({ title: "Revenue", height: 240 });
    expect(
      htmlRenderFromToolItem({ toolName: "mcp__t3-code__html_render", output: result.content }),
    ).toEqual(reference);
    // Only a full-access thread may have the server read a file for it.
    const byPath = (name: string, caller: McpInvocationContext.McpInvocationScope) =>
      server
        .callTool({
          name,
          arguments: {
            path: "/t3-missing-dir/revenue.html",
            ...(name === "html_render" ? { title: "Revenue", height: 240 } : {}),
          },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
          Effect.provideService(McpSchema.McpServerClient, client),
          // html_preview reports failures as plain text, html_render as a declared failure.
          Effect.map((result) => (result.isError ? JSON.stringify(result.content) : undefined)),
        );
    const fullAccess = { ...scope, thread: { ...scope.thread!, threadId: fullAccessThreadId } };
    for (const name of ["html_preview", "html_render"]) {
      expect(yield* byPath(name, scope), name).toContain("only full-access threads");
      expect(yield* byPath(name, fullAccess), name).toContain("not a readable HTML document");
    }
  }).pipe(
    Effect.provide(
      McpHttpServer.layerHtmlToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(McpProviderSessions.layer),
        Layer.provide(PreviewBrowser.layer),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-html-render-" })),
        Layer.provide(
          DocumentText.layer.pipe(
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed({
                id,
                deletedAt: null,
                archivedAt: null,
                activeRunId: RunId.make("mcp-core-run"),
                providerInstanceId: ProviderInstanceId.make("codex"),
                runtimeMode: id === fullAccessThreadId ? "full-access" : "approval-required",
                interactionMode: "default",
              } as OrchestrationV2ThreadShell),
          }),
        ),
      ),
    ),
  ),
);

it.effect("records only failed calls of tools that hand off no work", () => {
  // Recording runs detached from the tool response, so the first event is awaited.
  const recorded = Deferred.makeUnsafe<{ event: string; properties: object }>();
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const organize = (capabilities: McpInvocationContext.McpInvocationScope["capabilities"]) =>
      server.callTool({ name: "t3_thread_organize", arguments: { action: "pin" } }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...scope,
          capabilities,
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect((yield* organize(scope.capabilities)).isError).not.toBe(true);
    expect(declaredFailure(yield* organize(new Set<never>()))).toMatchObject({
      code: "capability_denied",
    });
    // The successful call ran first, so it would be the first event if it were recorded.
    expect(yield* Deferred.await(recorded)).toMatchObject({
      event: "mcp.tool.invoked",
      properties: { tool: "t3_thread_organize", outcome: "error" },
    });
  }).pipe(
    Effect.provide(
      layerThreadToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
            getProjectThreadRecords: ({ threadId: id }) =>
              Effect.succeed(
                McpToolAccessTestkit.idleThreadProjection(McpToolAccessTestkit.liveThreadShell(id)),
              ),
            listActiveShellIndex: () => Effect.succeed([]),
            dispatch: () => Effect.succeed({ sequence: 1 } as never),
          }),
        ),
        Layer.provide(
          Layer.succeed(
            AnalyticsService.AnalyticsService,
            AnalyticsService.AnalyticsService.of({
              record: (event, properties) =>
                Deferred.succeed(recorded, { event, properties: properties ?? {} }).pipe(
                  Effect.asVoid,
                ),
              flush: Effect.void,
              recordOwners: () => Effect.void,
            }),
          ),
        ),
      ),
    ),
  );
});

// A thread read whose runs or messages are bounded by nothing but the thread.
const historyReads = (
  reads: Array<string>,
  queued?: { readonly attachments: ReadonlyArray<unknown>; readonly dispatched: Array<unknown> },
) => {
  const record = (
    fields: ReadonlyArray<string>,
    filter: ProjectionStore.ProjectionRecordFilter | undefined,
  ) => {
    if (
      fields.includes("runs") &&
      filter?.runIds === undefined &&
      filter?.runStatuses === undefined
    )
      reads.push("every run");
    if (
      fields.includes("messages") &&
      filter?.messageIds === undefined &&
      filter?.messageRunIds === undefined
    )
      reads.push("every message");
  };
  const projection = McpToolAccessTestkit.idleThreadProjection(
    McpToolAccessTestkit.liveThreadShell(threadId),
  );
  return Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
    getProjectThreadRecords: (_target, fields, filter) =>
      Effect.sync(() => record(fields, filter)).pipe(Effect.as(projection as never)),
    getThreadRecords: (_id, fields, filter) =>
      Effect.sync(() => record(fields, filter)).pipe(
        Effect.as({
          ...projection,
          runs:
            queued === undefined
              ? projection.runs
              : [{ id: "run:queued", status: "queued", userMessageId: "message:queued" }],
        } as never),
      ),
    getMessagesById: () =>
      Effect.succeed(new Map(queued === undefined ? [] : [["message:queued", queued]]) as never),
    hasReceipt: () => Effect.succeed(false),
    dispatch: (command) =>
      Effect.sync(() => queued?.dispatched.push(command)).pipe(Effect.as({ sequence: 1 } as never)),
  });
};

it.effect("t3_queue list and read load only the queued runs and their messages", () => {
  const reads: Array<string> = [];
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (args: Record<string, unknown>) =>
      server
        .callTool({ name: "t3_queue", arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    yield* call({ action: "list" });
    yield* call({ action: "read", queuedRunId: "run:queued" });
    expect(reads).toEqual([]);
  }).pipe(
    Effect.provide(
      layerThreadToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(historyReads(reads)),
      ),
    ),
  );
});

it.effect("handoff analytics read only the caller's active run and its message", () => {
  const reads: Array<string> = [];
  const attachments = [{ type: "image", id: "shot", name: "shot.png" }];
  const dispatched: Array<unknown> = [];
  const recorded = Deferred.makeUnsafe<void>();
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    yield* server
      .callTool({
        name: "t3_queue",
        arguments: { action: "edit", queuedRunId: "run:queued", text: "Edited" },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    yield* Deferred.await(recorded);
    expect(reads).toEqual([]);
    // The edit keeps the queued image, so `/logout` stays an ordinary prompt and is not refused.
    const attached = yield* server
      .callTool({
        name: "t3_queue",
        arguments: { action: "edit", queuedRunId: "run:queued", text: " /LOGOUT " },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(attached.isError).not.toBe(true);
    expect(dispatched).toMatchObject([{ text: "Edited" }, { text: " /LOGOUT ", attachments }]);
    expect(dispatched[0]).not.toHaveProperty("attachments");
  }).pipe(
    Effect.provide(
      layerThreadToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(historyReads(reads, { attachments, dispatched })),
        Layer.provide(
          Layer.succeed(
            AnalyticsService.AnalyticsService,
            AnalyticsService.AnalyticsService.of({
              record: () => Deferred.succeed(recorded, undefined).pipe(Effect.asVoid),
              flush: Effect.void,
              recordOwners: () => Effect.void,
            }),
          ),
        ),
      ),
    ),
  );
});

it.effect("rejects an unknown organize target instead of archiving the calling thread", () => {
  const dispatched: Array<unknown> = [];
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const outcome = yield* server
      .callTool({
        name: "t3_thread_organize",
        arguments: { action: "archive", threadIds: ["other-thread"] },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.result,
      );
    expect(dispatched).toEqual([]);
    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { message: expect.stringContaining('Unknown argument "threadIds"') },
    });
  }).pipe(
    Effect.provide(
      layerThreadToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
            getProjectThreadRecords: ({ threadId: id }) =>
              Effect.succeed(
                McpToolAccessTestkit.idleThreadProjection(McpToolAccessTestkit.liveThreadShell(id)),
              ),
            dispatch: (command) => {
              dispatched.push(command);
              return Effect.succeed({ sequence: 1 } as never);
            },
          }),
        ),
      ),
    ),
  );
});

it.effect("keeps unexpected handler defects private through the production registration", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "t3_thread_organize", arguments: { action: "pin" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toEqual([
      { type: "text", text: "Tool execution failed due to an internal server error." },
    ]);
  }).pipe(
    Effect.provide(
      layerThreadToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () => Effect.die(new Error("private-storage-path")),
          }),
        ),
      ),
    ),
  ),
);

it("keeps MCP preference output allowlisted and Unicode-bounded", () => {
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    privateCredential: "must-not-escape",
    sourceControlWritingStyle: {
      ...DEFAULT_SERVER_SETTINGS.sourceControlWritingStyle,
      customInstructions: "🙂".repeat(4001),
    },
  };
  const result = EnvironmentHandlers.preferences(settings);
  expect(result).not.toHaveProperty("privateCredential");
  expect(result).not.toHaveProperty("providers");
  expect(result.sourceControlWritingStyle).toMatchObject({
    customInstructions: "🙂".repeat(4000),
    truncated: true,
  });
});

it.effect("resolves reused attachment references from stored metadata", () =>
  Effect.gen(function* () {
    const stored = ChatImageAttachment.make({
      type: "image",
      id: "owned-image",
      name: "original.png",
      mimeType: "image/png",
      sizeBytes: 12,
      source: {
        kind: "snap-shot",
        capturedAt: "2026-09-10T00:00:00.000Z",
        appName: "Terminal",
        windowTitle: "Test",
        accessibility: { format: "flat-text", text: "Stored context", truncated: false },
      },
    });
    const forged = yield* decodeMcpAttachmentInput({
      type: "image",
      id: stored.id,
      name: "changed.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 99,
    });
    const result = yield* AttachmentHandlers.resolveAttachmentReferences([forged], [stored]);
    expect(result).toEqual([stored]);
    const failure = yield* AttachmentHandlers.resolveAttachmentReferences(
      [{ ...forged, id: "other-image" }],
      [stored],
    ).pipe(Effect.flip);
    expect(failure.code).toBe("invalid_request");
  }),
);

const clientScope = (
  access: McpInvocationContext.McpClientCaller["access"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("mcp-core-environment"),
  requestNamespace: "client:session-1",
  thread: undefined,
  client: { sessionId: "session-1", label: "Claude Code", access },
  issuedAt: 0,
  capabilities: new Set(["orchestration", "worktree", "pull-requests", "issues"]),
});

it.effect("a client caller targets any thread within its ceiling and cannot act as a thread", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (
      name: string,
      args: Record<string, unknown>,
      invocation: McpInvocationContext.McpInvocationScope,
    ) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    const untargeted = yield* call("t3_thread_organize", { action: "pin" }, clientScope("auto"));
    expect(declaredFailure(untargeted)).toMatchObject({ code: "target_required" });

    const pinned = yield* call(
      "t3_thread_organize",
      { action: "pin", threadId: "other-project-thread" },
      clientScope("auto"),
    );
    expect(pinned.isError).toBe(false);
    expect(pinned.structuredContent).toMatchObject({ sequence: 7 });

    const aboveCeiling = yield* call(
      "t3_thread_organize",
      { action: "pin", threadId: "other-project-thread" },
      clientScope("approval-required"),
    );
    expect(declaredFailure(aboveCeiling)).toMatchObject({
      code: "runtime_mode_escalation_denied",
    });

    const forked = yield* call(
      "t3_thread_transfer",
      { action: "fork", sourcePoint: { type: "latest_stable" } },
      clientScope("auto"),
    );
    expect(declaredFailure(forked)).toMatchObject({ code: "target_required" });
  }).pipe(
    Effect.provide(
      layerThreadToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed(McpToolAccessTestkit.liveThreadShell(id, { runtimeMode: "auto" })),
            getProjectThreadRecords: () =>
              Effect.succeed({
                thread: {
                  id: ThreadId.make("other-project-thread"),
                  projectId: "other-project",
                  runtimeMode: "auto",
                  interactionMode: "default",
                  deletedAt: null,
                },
              } as never),
            listActiveShellIndex: () => Effect.succeed([]),
            dispatch: () => Effect.succeed({ sequence: 7, storedEvents: [] }),
          }),
        ),
      ),
    ),
  ),
);

it.effect("an MCP pin lands above every existing pin, as a client pin does", () => {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  let targetPinnedAt: DateTime.Utc | null = null;
  const pinnedAt = DateTime.makeUnsafe("2026-11-10T00:00:00.000Z");
  const indexEntry = (id: string, pinned: boolean, pinOrderKey: string | null) => ({
    ...McpToolAccessTestkit.liveThreadShell(ThreadId.make(id)),
    pinnedAt: pinned ? pinnedAt : null,
    pinOrderKey,
    mayBeLive: false,
    hasRemoteTasks: false,
  });
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const pin = server
      .callTool({
        name: "t3_thread_organize",
        arguments: { action: "pin", threadId: "pin-target" },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, clientScope("auto")),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    const first = yield* pin;
    expect(first.isError).toBe(false);
    const orderKey = (dispatched[0] as { readonly orderKey?: string }).orderKey;
    expect(dispatched[0]).toMatchObject({ type: "thread.pin", threadId: "pin-target" });
    // The smallest key among pinned threads is "g"; the unpinned "b" and keyless pin are ignored.
    expect(orderKey).toBe(pinOrderKeyBetween(null, "g"));

    // A thread the handler last saw pinned still gets a key: an unpin can commit
    // before this command, and the reducer ignores the key if the pin holds.
    targetPinnedAt = pinnedAt;
    const again = yield* pin;
    expect(again.isError).toBe(false);
    expect(dispatched[1]).toMatchObject({ type: "thread.pin", orderKey });
  }).pipe(
    Effect.provide(
      layerThreadToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed(McpToolAccessTestkit.liveThreadShell(id, { runtimeMode: "auto" })),
            getProjectThreadRecords: ({ threadId: id }) => {
              const projection = McpToolAccessTestkit.idleThreadProjection(
                McpToolAccessTestkit.liveThreadShell(id, { runtimeMode: "auto" }),
              );
              return Effect.succeed({
                ...projection,
                thread: { ...projection.thread, pinnedAt: targetPinnedAt },
              });
            },
            listActiveShellIndex: () =>
              Effect.succeed([
                indexEntry("pinned-late", true, "t"),
                indexEntry("pinned-top", true, "g"),
                indexEntry("pinned-keyless", true, null),
                indexEntry("unpinned-stale-key", false, "b"),
              ]),
            dispatch: (command) => {
              dispatched.push(command);
              return Effect.succeed({ sequence: dispatched.length, storedEvents: [] });
            },
          }),
        ),
      ),
    ),
  );
});

it.effect("an MCP move places a pin inside a sidebar section, between its neighbors", () => {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const pinnedAt = DateTime.makeUnsafe("2026-11-10T00:00:00.000Z");
  const indexEntry = (id: string, pinOrderKey: string, pinSectionId: string | null) => ({
    ...McpToolAccessTestkit.liveThreadShell(ThreadId.make(id)),
    pinnedAt,
    pinOrderKey,
    pinSectionId,
    mayBeLive: false,
    hasRemoteTasks: false,
  });
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (name: string, args: Record<string, unknown>) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, clientScope("auto")),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    const moved = yield* call("t3_thread_organize", {
      action: "move",
      threadId: "plain-pin",
      sectionId: "work",
      beforeThreadId: "work-second",
    });
    expect(moved.isError).toBe(false);
    expect(dispatched).toEqual([
      expect.objectContaining({
        type: "thread.pin.reorder",
        threadId: "plain-pin",
        orderKey: pinOrderKeyBetween("f", "t"),
        sectionId: "work",
      }),
    ]);

    const toEnd = yield* call("t3_thread_organize", {
      action: "move",
      threadId: "plain-pin",
      sectionId: "work",
    });
    expect(toEnd.isError).toBe(false);
    expect(dispatched[1]).toMatchObject({
      type: "thread.pin.reorder",
      threadId: "plain-pin",
      orderKey: pinOrderKeyBetween("t", null),
      sectionId: "work",
    });

    const unknown = yield* call("t3_thread_organize", {
      action: "pin",
      threadId: "plain-pin",
      sectionId: "missing",
    });
    expect(declaredFailure(unknown)).toMatchObject({ code: "invalid_request" });

    const created = yield* call("t3_sidebar_section", { action: "create", title: "Later" });
    expect(created.isError).toBe(false);
    const listed = yield* call("t3_sidebar_section", { action: "list" });
    expect(listed.structuredContent).toMatchObject({
      sections: [{ id: "work", title: "Work" }, { title: "Later" }],
    });

    const laterId = (created.structuredContent as { readonly sectionId: string }).sectionId;
    const renamed = yield* call("t3_sidebar_section", {
      action: "rename",
      sectionId: "work",
      title: "Deep work",
    });
    expect(renamed.structuredContent).toMatchObject({
      sections: [{ id: "work", title: "Deep work" }, { id: laterId }],
    });
    const raised = yield* call("t3_sidebar_section", {
      action: "reorder",
      sectionId: laterId,
      beforeSectionId: "work",
    });
    expect(raised.structuredContent).toMatchObject({ sections: [{ id: laterId }, { id: "work" }] });
    const lowered = yield* call("t3_sidebar_section", { action: "reorder", sectionId: laterId });
    expect(lowered.structuredContent).toMatchObject({
      sections: [{ id: "work" }, { id: laterId }],
    });

    const deleted = yield* call("t3_sidebar_section", { action: "delete", sectionId: "work" });
    expect(deleted.isError).toBe(false);
    // Its pins leave the section before it goes, keeping their place.
    expect(dispatched.slice(2)).toEqual([
      expect.objectContaining({ threadId: "work-second", orderKey: "t", sectionId: null }),
      expect.objectContaining({ threadId: "work-first", orderKey: "f", sectionId: null }),
    ]);
    expect(deleted.structuredContent).toMatchObject({ sections: [{ title: "Later" }] });
  }).pipe(
    Effect.provide(
      threadToolkitWithSettings({ sidebarSections: [{ id: "work", title: "Work" }] }).pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed(McpToolAccessTestkit.liveThreadShell(id, { runtimeMode: "auto" })),
            getProjectThreadRecords: ({ threadId: id }) => {
              const projection = McpToolAccessTestkit.idleThreadProjection(
                McpToolAccessTestkit.liveThreadShell(id, { runtimeMode: "auto" }),
              );
              return Effect.succeed({
                ...projection,
                thread: { ...projection.thread, pinnedAt, pinOrderKey: "m", pinSectionId: null },
              });
            },
            listActiveShellIndex: () =>
              Effect.succeed([
                indexEntry("work-second", "t", "work"),
                indexEntry("plain-pin", "m", null),
                indexEntry("work-first", "f", "work"),
              ]),
            dispatch: (command) => {
              dispatched.push(command);
              return Effect.succeed({ sequence: dispatched.length, storedEvents: [] });
            },
          }),
        ),
      ),
    ),
  );
});

it.effect("search names the calling thread, so an agent can tell its own match apart", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const search = (invocation: McpInvocationContext.McpInvocationScope) =>
      server
        .callTool({ name: "t3_thread_search", arguments: { query: "release notes" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    const fromThread = yield* search(scope);
    expect(fromThread.structuredContent).toMatchObject({
      currentThreadId: threadId,
      matches: [{ threadId }, { threadId: "earlier-thread" }],
    });

    const fromClient = yield* search(clientScope("auto"));
    expect(fromClient.structuredContent).toMatchObject({ currentThreadId: null });

    // A linked environment on an older version answers without the field.
    const fromOlderPeer = yield* decodeThreadSearchResult({ matches: [] });
    expect(fromOlderPeer).toEqual({ matches: [] });
  }).pipe(
    Effect.provide(
      McpHttpServer.layerThreadToolkit.pipe(
        Layer.provide(layerNoSessionSync),
        Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provide(
          Layer.mock(ThreadSearch.ThreadSearch)({
            searchThreads: () =>
              Effect.succeed({
                matches: [threadId, ThreadId.make("earlier-thread")].map((id) => ({
                  threadId: id,
                  projectId: ProjectId.make("project:mcp-test"),
                  title: "Release notes",
                  source: "title" as const,
                  snippet: "",
                  messageCreatedAt: null,
                })),
              }),
          }),
        ),
        Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
        Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
        Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
        Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
      ),
    ),
  ),
);

it.effect("a read-only client reads threads and is refused every write before it runs", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (name: string, args: Record<string, unknown>) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            clientScope("read-only"),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    const configuration = yield* call("t3_thread_configure", {
      threadId: "other-project-thread",
    });
    expect(configuration.isError).toBe(false);
    expect(configuration.structuredContent).toMatchObject({ runtimeMode: "auto" });

    const pinned = yield* call("t3_thread_organize", {
      action: "pin",
      threadId: "other-project-thread",
    });
    expect(declaredFailure(pinned)).toMatchObject({ code: "capability_denied" });
    expect(dispatched).toEqual([]);

    const configure = yield* call("t3_thread_configure", {
      threadId: "other-project-thread",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
    });
    expect(declaredFailure(configure)).toMatchObject({ code: "capability_denied" });
    expect(dispatched).toEqual([]);
  }).pipe(
    Effect.provide(
      layerThreadToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed({
                id: ThreadId.make("other-project-thread"),
                projectId: "other-project",
                deletedAt: null,
              } as never),
            getProjectThreadRecords: () =>
              Effect.succeed({
                thread: {
                  id: ThreadId.make("other-project-thread"),
                  projectId: "other-project",
                  modelSelection: { instanceId: "codex", model: "gpt-5" },
                  runtimeMode: "auto",
                  interactionMode: "default",
                  deletedAt: null,
                },
              } as never),
            dispatch: () =>
              Effect.sync(() => {
                dispatched.push("dispatch");
                return { sequence: 7 } as never;
              }),
          }),
        ),
      ),
    ),
  ),
);
const dispatched: Array<string> = [];

it.effect("hides act-as-caller tools from a client caller", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const error = yield* server
      .callTool({
        name: "delegate_task",
        arguments: { task: "Review", mode: "async" },
      })
      .pipe(
        Effect.flip,
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          clientScope("full-access"),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(error.message).toContain("Tool 'delegate_task' not found");
  }).pipe(
    Effect.provide(
      layerOrchestratorToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
        Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
        Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
        Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
        Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
        Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
      ),
    ),
  ),
);

it.effect("a caller cannot rewrite a scheduled task that runs above its own modes", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (name: string, args: Record<string, unknown>) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, clientScope("auto")),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    const update = yield* call("schedule_task", {
      scheduledTaskId: "task-full-access",
      prompt: "Run something else",
    });
    expect(declaredFailure(update)).toMatchObject({ code: "runtime_mode_escalation_denied" });
    const remove = yield* call("delete_scheduled_task", { scheduledTaskId: "task-full-access" });
    expect(declaredFailure(remove)).toMatchObject({ code: "runtime_mode_escalation_denied" });
    const allowed = yield* call("schedule_task", {
      scheduledTaskId: "task-auto",
      enabled: false,
    });
    expect(allowed.isError).toBe(false);
    const fresh = yield* call("schedule_task", {
      scheduledTaskId: "task-auto",
      freshSession: true,
    });
    expect(fresh.structuredContent).toMatchObject({ freshSession: true });
    const incomplete = yield* call("schedule_task", { prompt: "Run nightly" });
    expect(declaredFailure(incomplete)).toMatchObject({ code: "invalid_request" });
  }).pipe(
    Effect.provide(
      layerOrchestratorToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
        Layer.provide(
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({
            list: () =>
              Effect.succeed({
                tasks: [
                  scheduledTask("task-full-access", "full-access"),
                  scheduledTask("task-auto", "auto"),
                ],
              }),
            upsert: (input) =>
              Effect.succeed({
                task: { ...(scheduledTask(input.id ?? "task-auto", "auto") as object), ...input },
              } as never),
          }),
        ),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
        Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
        Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
        Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
        Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
      ),
    ),
  ),
);

it.effect.each([
  {
    scenario: "explains why a webhook task cannot run manually",
    tasks: [
      {
        ...Schema.decodeSync(ScheduledTask)(scheduledTask("task-webhook", "full-access")),
        schedule: { type: "webhook" as const, signature: null },
      },
    ],
    error: new ScheduledTaskError({
      message: "Webhook tasks run when their URL receives a request.",
      cause: new Error("private-webhook-cause"),
    }),
    code: "orchestration_error",
    message: "Webhook tasks run when their URL receives a request.",
  },
  {
    scenario: "reports a missing task before trying to run it",
    tasks: [],
    error: new ScheduledTaskError({ message: "must not run a missing task" }),
    code: "invalid_request",
    message: "The scheduled task was not found.",
  },
])("run_scheduled_task_now $scenario", ({ tasks, error, code, message }) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "run_scheduled_task_now", arguments: { taskId: "task-webhook" } })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          clientScope("full-access"),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(declaredFailure(result)).toEqual({ _tag: "OrchestratorMcpFailure", code, message });
    expect(JSON.stringify(result)).not.toContain("private-");
  }).pipe(
    Effect.provide(
      McpHttpServer.layerThreadToolkit.pipe(
        Layer.provide(layerNoSessionSync),
        Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
        Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
        Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
        Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
        Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
        Layer.provide(
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({
            list: () => Effect.succeed({ tasks }),
            runNow: () => Effect.fail(error),
          }),
        ),
      ),
    ),
  ),
);

it.effect("run_scheduled_task_now reports why a started run failed to dispatch", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "run_scheduled_task_now", arguments: { taskId: "task-full-access" } })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          clientScope("full-access"),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      threadId: null,
      lastRunStatus: "failed",
      lastRunError: "the provider is disabled",
    });
  }).pipe(
    Effect.provide(
      McpHttpServer.layerThreadToolkit.pipe(
        Layer.provide(layerNoSessionSync),
        Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
        Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
        Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
        Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
        Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
        Layer.provide(
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({
            list: () =>
              Effect.succeed({ tasks: [scheduledTask("task-full-access", "full-access")] }),
            runNow: () =>
              Effect.succeed({
                threadId: null,
                task: {
                  ...(scheduledTask("task-full-access", "full-access") as object),
                  lastRunStatus: "failed" as const,
                  lastRunError: "the provider is disabled",
                },
              } as never),
          }),
        ),
      ),
    ),
  ),
);

function scheduledTask(id: string, runtimeMode: "auto" | "full-access"): never {
  return {
    id,
    title: id,
    prompt: "Check the build",
    enabled: true,
    projectId: "project-a",
    threadId: null,
    schedule: { type: "interval", everyMs: 3_600_000 },
    workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode,
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    nextRunAt: null,
    lastRunStatus: "never",
    lastRunAt: null,
    lastRunThreadId: null,
    lastRunError: null,
    runCount: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  } as never;
}

it.effect.each(["t3_thread_interrupt", "t3_workflow_stop"])(
  "a caller cannot use %s on a thread that runs above its own modes",
  (toolName) =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: toolName,
          arguments: {
            threadId: "full-access-thread",
            ...(toolName === "t3_workflow_stop" ? { subagentId: "workflow-coordinator" } : {}),
          },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, clientScope("auto")),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(declaredFailure(result)).toMatchObject({ code: "runtime_mode_escalation_denied" });
    }).pipe(
      Effect.provide(
        layerOrchestratorToolkit.pipe(
          Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
          Layer.provide(NodeCrypto.layer),
          Layer.provide(
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: () =>
                Effect.succeed({
                  projectId: "project-a",
                  deletedAt: null,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                } as never),
              getProjectThreadRecords: () =>
                Effect.succeed({
                  thread: {
                    id: ThreadId.make("full-access-thread"),
                    projectId: "project-a",
                    runtimeMode: "full-access",
                    interactionMode: "default",
                    deletedAt: null,
                  },
                  runs: [],
                } as never),
              stopWorkflow: () => Effect.die("workflow stop must not dispatch above the ceiling"),
              interruptThread: () => Effect.die("interrupt must not dispatch above the ceiling"),
            }),
          ),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
          Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
          Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
          Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
          Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
          Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
          Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
          Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
          Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
        ),
      ),
    ),
);

it.effect(
  "t3_background_wait marks work from a turn Claude started before T3 started its run",
  () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({ name: "t3_background_wait", arguments: { taskIds: ["checks"] } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            ...scope,
            capabilities: new Set<McpInvocationContext.McpCapability>([
              "orchestration",
              "background-wait",
            ]),
          }),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(result.structuredContent).toEqual({ matched: ["checks"], unmatched: [] });
    }).pipe(
      Effect.provide(
        layerOrchestratorToolkit.pipe(
          Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
          Layer.provide(NodeCrypto.layer),
          Layer.provide(
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: (id) =>
                Effect.succeed(McpToolAccessTestkit.liveThreadShell(id, { activeRunId: null })),
              awaitBackgroundTasks: ({ taskIds }) =>
                Effect.succeed({ matched: taskIds, unmatched: [] }),
            }),
          ),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
          Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
          Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
          Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
          Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
          Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
          Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
          Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
          Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
        ),
      ),
    ),
);

it.effect("discovers workflow stop targets and requires orchestration capability", () => {
  const threadId = ThreadId.make("workflow-parent");
  const shell = McpToolAccessTestkit.liveThreadShell(threadId);
  const subagentId = NodeId.make("workflow-coordinator");
  const itemId = TurnItemId.make("workflow-coordinator-activity");
  const row: OrchestrationV2ProjectedTurnItem = {
    position: 0,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: itemId,
    item: {
      id: itemId,
      threadId,
      runId: shell.activeRunId,
      nodeId: subagentId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "running",
      title: "Workflow: checkout review",
      startedAt: shell.createdAt,
      completedAt: null,
      updatedAt: shell.updatedAt,
      type: "subagent",
      subagentId,
      origin: "provider_native",
      driver: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      childThreadId: ThreadId.make("workflow-child"),
      prompt: "Review checkout",
      result: null,
    },
  };
  const stopped: Array<{ readonly threadId: ThreadId; readonly subagentId: string }> = [];
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const scope = clientScope("full-access");
    const read = yield* server
      .callTool({ name: "t3_thread_read", arguments: { threadId, view: "activity" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(read.isError).toBe(false);
    const result = yield* decodeThreadReadResult(read.structuredContent);
    expect(result.items[0]?.subagentId).toBe(subagentId);
    const call = (invocation: McpInvocationContext.McpInvocationScope) =>
      server
        .callTool({
          name: "t3_workflow_stop",
          arguments: { threadId, subagentId: result.items[0]?.subagentId },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    const denied = yield* call({ ...scope, capabilities: new Set(["worktree"]) });
    expect(declaredFailure(denied)).toMatchObject({ code: "capability_denied" });
    expect(stopped).toEqual([]);
    const allowed = yield* call(scope);
    expect(allowed.isError).toBe(false);
    expect(stopped).toEqual([{ threadId: "workflow-parent", subagentId: "workflow-coordinator" }]);
  }).pipe(
    Effect.provide(
      layerOrchestratorToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
            getProjectThreadRecords: () =>
              Effect.succeed(McpToolAccessTestkit.idleThreadProjection(shell)),
            getRunCount: () => Effect.succeed(1),
            getTimelinePage: () =>
              Effect.succeed({ items: [row], totalItems: 1, hasMore: false, hasEarlier: false }),
            stopWorkflow: (input) =>
              Effect.sync(() => {
                stopped.push(input);
              }),
          }),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
        Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
        Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
        Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
        Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
        Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
      ),
    ),
  );
});

it.effect("only the caller that prepared a pending upload can discard it", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (
      name: string,
      args: Record<string, unknown>,
      invocation: McpInvocationContext.McpInvocationScope,
    ) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    const prepared = yield* call(
      "t3_attachment_prepare_upload",
      { upload: { name: "shot.png", mimeType: "image/png", sizeBytes: 4 } },
      scope,
    );
    const { attachmentId } = prepared.structuredContent as { readonly attachmentId: string };
    const otherThread = {
      ...scope,
      requestNamespace: "other-session",
      thread: { ...scope.thread!, threadId: ThreadId.make("other-thread") },
    };

    const refused = yield* call("t3_attachment_discard", { attachmentId }, otherThread);
    expect(declaredFailure(refused)).toMatchObject({ code: "invalid_request" });

    yield* TestClock.adjust(24 * 60 * 60 * 1000 + 5 * 60_000);
    yield* call(
      "t3_attachment_prepare_upload",
      { upload: { name: "later.png", mimeType: "image/png", sizeBytes: 4 } },
      scope,
    );

    const discarded = yield* call(
      "t3_attachment_discard",
      { attachmentId },
      { ...scope, requestNamespace: "mcp-core-session-2" },
    );
    expect(discarded.isError).toBe(false);
  }).pipe(
    Effect.provide(
      McpHttpServer.layerAttachmentToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provide(AssetSigner.layer.pipe(Layer.provideMerge(ServerSecretStore.layer))),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-attachment-" })),
        Layer.provide(
          DocumentText.layer.pipe(
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
        Layer.provide(NodeCrypto.layer),
      ),
    ),
  ),
);

const sendTargetId = ThreadId.make("send-target-thread");
const sendCommand = {
  commandId: CommandId.make("mcp-core-send"),
  commandType: "message.dispatch",
};

it.effect.each([
  {
    outcome: "says that the missing workspace could not be recreated",
    refusal: new ThreadManagement.ThreadManagementWorktreeRestoreError({
      threadId: sendTargetId,
      cause: new Error("The branch no longer exists."),
    }),
    reply: {
      _tag: "OrchestratorMcpFailure",
      code: "thread_not_sendable",
      message:
        "Couldn't recreate the missing workspace of thread send-target-thread, so the message was not sent. The branch no longer exists.",
    },
  },
  {
    outcome: "passes on the text reason of an orchestrator rejection",
    refusal: new OrchestratorCommandRejectedError({
      ...sendCommand,
      cause: "Thread send-target-thread is deleted.",
    }),
    reply: {
      _tag: "OrchestratorMcpFailure",
      code: "orchestration_error",
      message: "Thread send-target-thread is deleted.",
    },
  },
  {
    outcome: "keeps an internal dispatch cause private",
    refusal: new OrchestratorDispatchError({
      ...sendCommand,
      cause: new Error("private-storage-path"),
    }),
    reply: {
      _tag: "OrchestratorMcpFailure",
      code: "orchestration_error",
      message: "The operation could not be completed.",
    },
  },
])("t3_thread_send_attachments $outcome", ({ refusal, reply }) => {
  const stored = ChatImageAttachment.make({
    type: "image",
    id: "owned-image",
    name: "original.png",
    mimeType: "image/png",
    sizeBytes: 12,
  });
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: "t3_thread_send_attachments",
        arguments: { threadId: sendTargetId, message: "See the file.", attachments: [stored] },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(declaredFailure(result)).toEqual(reply);
  }).pipe(
    Effect.provide(
      McpHttpServer.layerAttachmentToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
            getProjectThreadRecords: () =>
              Effect.succeed({
                ...McpToolAccessTestkit.idleThreadProjection(
                  McpToolAccessTestkit.liveThreadShell(sendTargetId),
                ),
                messages: [{ attachments: [stored] }],
              } as never),
            sendToThread: () => Effect.fail(refusal),
          }),
        ),
        Layer.provide(AssetSigner.layer.pipe(Layer.provideMerge(ServerSecretStore.layer))),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-attachment-" })),
        Layer.provide(
          DocumentText.layer.pipe(
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
        Layer.provide(NodeCrypto.layer),
      ),
    ),
  );
});

it.effect(
  "t3_thread_list settled:false with an empty statuses list lists the unsettled threads",
  () => {
    const unsettled = McpToolAccessTestkit.liveThreadShell(ThreadId.make("unsettled-thread"));
    const settled = {
      ...McpToolAccessTestkit.liveThreadShell(ThreadId.make("settled-thread")),
      settledOverride: "settled",
    } as const;
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "t3_thread_list",
          arguments: { projectId: unsettled.projectId, settled: false, statuses: [] },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            clientScope("full-access"),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        threads: [{ threadId: unsettled.id, settled: false }],
        total: 1,
      });
    }).pipe(
      Effect.provide(
        layerOrchestratorToolkit.pipe(
          Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
          Layer.provide(NodeCrypto.layer),
          Layer.provide(
            Layer.mock(ThreadManagement.ThreadManagementService)({
              listProjectThreads: () => Effect.succeed([unsettled, settled]),
              getShellSnapshot: () => Effect.succeed({ threads: [unsettled, settled] } as never),
            }),
          ),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
          Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
          Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
          Layer.provide(
            Layer.mock(ProjectService.ProjectService)({
              getById: (projectId) =>
                Effect.succeedSome({
                  id: projectId,
                  title: "MCP test",
                  workspaceRoot: "/repo",
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: "2026-10-18T00:00:00.000Z",
                  updatedAt: "2026-10-18T00:00:00.000Z",
                  deletedAt: null,
                }),
            }),
          ),
          Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
          Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
          Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
          Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
          Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
        ),
      ),
    );
  },
);

it.effect("MCP nest and unnest set a thread's placement, and a move away unnests it", () => {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const pinnedAt = DateTime.makeUnsafe("2026-11-10T00:00:00.000Z");
  const parentId = ThreadId.make("spawner");
  let spawnedSection: string | null = null;
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (args: Record<string, unknown>) =>
      server
        .callTool({ name: "t3_thread_organize", arguments: { threadId: "spawned", ...args } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, clientScope("auto")),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    expect(declaredFailure(yield* call({ action: "nest" }))).toMatchObject({
      code: "invalid_request",
    });
    expect((yield* call({ action: "nest", parentThreadId: "other" })).isError).toBe(false);
    expect((yield* call({ action: "unnest" })).isError).toBe(false);
    expect(dispatched).toEqual([
      expect.objectContaining({ type: "thread.nest.set", parentThreadId: "other" }),
      expect.objectContaining({ type: "thread.nest.set", parentThreadId: null }),
    ]);

    // Into its parent's section, it stays nested.
    dispatched.length = 0;
    expect((yield* call({ action: "move", sectionId: "work" })).isError).toBe(false);
    expect(dispatched).toContainEqual(
      expect.objectContaining({
        type: "thread.pin.reorder",
        threadId: "spawned",
        sectionId: "work",
      }),
    );
    expect(dispatched.some((command) => command.type === "thread.nest.set")).toBe(false);

    // Before a sibling it is reordered among its siblings and stays nested.
    dispatched.length = 0;
    expect((yield* call({ action: "move", beforeThreadId: "sibling" })).isError).toBe(false);
    expect(dispatched).toEqual([
      expect.objectContaining({ type: "thread.pin.reorder", threadId: "spawned" }),
    ]);
    const siblingKey = (dispatched[0] as { orderKey: string }).orderKey;
    expect(siblingKey > "c" && siblingKey < "k").toBe(true);

    // Above its parent it leaves the parent's group.
    dispatched.length = 0;
    expect((yield* call({ action: "move", beforeThreadId: "spawner" })).isError).toBe(false);
    expect(dispatched.at(-1)).toEqual(
      expect.objectContaining({ type: "thread.nest.set", parentThreadId: null }),
    );

    // Into another list, it no longer sits under its parent.
    dispatched.length = 0;
    expect((yield* call({ action: "move", sectionId: "other" })).isError).toBe(false);
    expect(dispatched).toEqual([
      expect.objectContaining({
        type: "thread.pin.reorder",
        threadId: "spawned",
        sectionId: "other",
      }),
      expect.objectContaining({
        type: "thread.nest.set",
        threadId: "spawned",
        parentThreadId: null,
      }),
    ]);

    // A linked environment's thread nests here through this machine's settings.
    dispatched.length = 0;
    const settings = yield* ServerSettings.ServerSettingsService;
    const remoteThread = { environmentId: "environment-box", threadId: "mcp:launch:box" };
    const organizeRemote = (args: Record<string, unknown>) =>
      server
        .callTool({ name: "t3_thread_organize", arguments: { remoteThread, ...args } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, clientScope("auto")),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    expect(
      declaredFailure(yield* organizeRemote({ action: "pin", threadId: "spawned" })),
    ).toMatchObject({ code: "invalid_request" });
    const nested = yield* organizeRemote({ action: "nest", parentThreadId: "spawner" });
    expect(nested.structuredContent).toEqual({ remoteThreadNestParent: "spawner" });
    expect((yield* settings.getSettings).remoteThreadNestParents).toEqual([
      { ...remoteThread, parentThreadId: "spawner" },
    ]);
    yield* organizeRemote({ action: "unnest" });
    expect((yield* settings.getSettings).remoteThreadNestParents).toEqual([
      { ...remoteThread, parentThreadId: null },
    ]);
    expect(dispatched).toEqual([]);

    expect((yield* call({ action: "unnest", sectionId: null })).isError).toBe(false);
    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.pin.reorder",
      "thread.nest.set",
    ]);
  }).pipe(
    Effect.provide(
      threadToolkitWithSettings({
        sidebarSections: [
          { id: "work", title: "Work" },
          { id: "other", title: "Other" },
        ],
      }).pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed(McpToolAccessTestkit.liveThreadShell(id, { runtimeMode: "auto" })),
            getProjectThreadRecords: ({ threadId: id }) => {
              const projection = McpToolAccessTestkit.idleThreadProjection(
                McpToolAccessTestkit.liveThreadShell(id, { runtimeMode: "auto" }),
              );
              return Effect.succeed({
                ...projection,
                thread: {
                  ...projection.thread,
                  pinnedAt,
                  pinOrderKey: "m",
                  pinSectionId: spawnedSection,
                  lineage: { ...projection.thread.lineage, spawnedBy: parentId },
                },
              });
            },
            listActiveShellIndex: () =>
              Effect.succeed([
                {
                  ...McpToolAccessTestkit.liveThreadShell(ThreadId.make("spawned")),
                  pinnedAt,
                  pinOrderKey: "m",
                  pinSectionId: spawnedSection,
                  mayBeLive: false,
                  hasRemoteTasks: false,
                },
                {
                  ...McpToolAccessTestkit.liveThreadShell(parentId),
                  pinnedAt,
                  pinOrderKey: "c",
                  pinSectionId: "work",
                  mayBeLive: false,
                  hasRemoteTasks: false,
                },
                {
                  ...McpToolAccessTestkit.liveThreadShell(ThreadId.make("sibling")),
                  lineage: {
                    ...McpToolAccessTestkit.liveThreadShell(ThreadId.make("sibling")).lineage,
                    spawnedBy: parentId,
                  },
                  pinnedAt,
                  pinOrderKey: "k",
                  pinSectionId: "work",
                  mayBeLive: false,
                  hasRemoteTasks: false,
                },
              ]),
            dispatch: (command) => {
              if (
                (command.type === "thread.pin.reorder" || command.type === "thread.pin") &&
                command.threadId === "spawned" &&
                command.sectionId !== undefined
              )
                spawnedSection = command.sectionId;
              dispatched.push(command);
              return Effect.succeed({ sequence: dispatched.length, storedEvents: [] });
            },
          }),
        ),
      ),
    ),
  );
});

it.effect("t3_claude_sessions_sync imports, then mirrors Claude sections and stars", () => {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const imports: Array<{ readonly dryRun: boolean }> = [];
  const pinnedAt = DateTime.makeUnsafe("2026-11-10T00:00:00.000Z");
  const projectId = ProjectId.make("project:mcp-test");
  const claudeThread = (
    session: string,
    pin?: { readonly key: string; readonly section: string | null },
    lineage?: Record<string, unknown>,
  ) => ({
    ...McpToolAccessTestkit.liveThreadShell(ThreadId.make(`import:claudeAgent:${session}`)),
    ...(lineage === undefined
      ? {}
      : {
          lineage: {
            ...McpToolAccessTestkit.liveThreadShell(ThreadId.make(`import:claudeAgent:${session}`))
              .lineage,
            ...lineage,
          },
        }),
    pinnedAt: pin === undefined ? null : pinnedAt,
    pinOrderKey: pin?.key ?? null,
    pinSectionId: pin?.section ?? null,
    mayBeLive: false,
    hasRemoteTasks: false,
  });
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const settings = yield* ServerSettings.ServerSettingsService;
    const sync = (args: Record<string, unknown>) =>
      server
        .callTool({ name: "t3_claude_sessions_sync", arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, clientScope("auto")),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    const dry = yield* sync({ dryRun: true });
    expect(dry.isError).toBe(false);
    expect(dispatched).toEqual([]);
    expect((yield* settings.getSettings).sidebarSections).toEqual([
      { id: "fin", title: "FinSearch" },
      { id: "mine", title: "Mine" },
    ]);
    const expected = {
      totals: { imported: 1, refreshed: 1, unchanged: 3, nested: 1, skipped: { diverged: 1 } },
      sectionsCreated: ["Legal"],
      moved: [
        // A brand-new import lands in its section; a thread already there stays put.
        { threadId: "import:claudeAgent:in-mine", from: "Mine", to: "FinSearch" },
        { threadId: "import:claudeAgent:new", from: null, to: "FinSearch" },
        { threadId: "import:claudeAgent:legal", from: null, to: "Legal" },
      ],
      pinned: [{ threadId: "import:claudeAgent:starred" }],
      // A child follows its parent into the parent's section, and its own child follows it.
      keptWithParent: [
        {
          threadId: "import:claudeAgent:child",
          parentThreadId: "import:claudeAgent:in-fin",
          to: "FinSearch",
        },
        {
          threadId: "import:claudeAgent:grandchild",
          parentThreadId: "import:claudeAgent:child",
          to: "FinSearch",
        },
      ],
      claudeDesktop: { sections: 2, assignedSessions: 5, starredSessions: 2 },
    };
    expect(dry.structuredContent).toMatchObject({ dryRun: true, ...expected });

    const applied = yield* sync({});
    expect(applied.structuredContent).toMatchObject({
      dryRun: false,
      ...expected,
      // This time the mock import only brought in the child.
      totals: { ...expected.totals, imported: 1 },
      moved: expected.moved.filter((move) => move.threadId !== "import:claudeAgent:new"),
    });
    expect(imports).toEqual([{ dryRun: true }, { dryRun: false }]);
    const sections = (yield* settings.getSettings).sidebarSections;
    expect(sections.map((section) => section.title)).toEqual(["FinSearch", "Mine", "Legal"]);
    const legalId = sections[2]!.id;
    // Moves may also rekey neighbors; these are the writes that place each thread.
    expect(dispatched.filter((command) => "sectionId" in command)).toEqual([
      expect.objectContaining({
        type: "thread.pin.reorder",
        threadId: "import:claudeAgent:in-mine",
        sectionId: "fin",
      }),
      expect.objectContaining({
        type: "thread.pin",
        threadId: "import:claudeAgent:legal",
        sectionId: legalId,
      }),
      expect.objectContaining({
        type: "thread.pin",
        threadId: "import:claudeAgent:starred",
        sectionId: null,
      }),
      expect.objectContaining({
        type: "thread.pin",
        threadId: "import:claudeAgent:child",
        sectionId: "fin",
      }),
      expect.objectContaining({
        type: "thread.pin",
        threadId: "import:claudeAgent:grandchild",
        sectionId: "fin",
      }),
    ]);
    // A brand-new import goes to the top of its section; an earlier one, to the end.
    const placedKey = (threadId: string) => {
      const command = dispatched.find(
        (candidate) => candidate.type === "thread.pin" && candidate.threadId === threadId,
      );
      return command?.type === "thread.pin" ? command.orderKey : undefined;
    };
    expect(placedKey("import:claudeAgent:child")! < "n").toBe(true);
    expect(placedKey("import:claudeAgent:grandchild")! > "n").toBe(true);
    // Nesting stays: the sync never unnests what it places.
    expect(dispatched.some((command) => command.type === "thread.nest.set")).toBe(false);
  }).pipe(
    Effect.provide(
      threadToolkitWithSettings(
        {
          sidebarSections: [
            { id: "fin", title: "FinSearch" },
            { id: "mine", title: "Mine" },
          ],
        },
        {
          projects: {
            listPage: () =>
              Effect.succeed({
                projects: [
                  {
                    id: projectId,
                    title: "master",
                    workspaceRoot: "/repo",
                    defaultModelSelection: null,
                    scripts: [],
                    createdAt: "2026-11-01T00:00:00.000Z",
                    updatedAt: "2026-11-01T00:00:00.000Z",
                    deletedAt: null,
                  },
                ],
                nextCursor: null,
              }),
          },
          importer: {
            importAgentThreads: (_input, options) => {
              imports.push({ dryRun: options?.dryRun === true });
              return Effect.succeed({
                imported: [
                  ThreadId.make(
                    options?.dryRun === true
                      ? "import:claudeAgent:new"
                      : "import:claudeAgent:child",
                  ),
                ],
                refreshed: [ThreadId.make("import:claudeAgent:in-fin")],
                unchangedCount: 3,
                linked: [ThreadId.make("import:claudeAgent:legal")],
                skipped: { diverged: 1 },
                skippedCount: 1,
              });
            },
          },
          scanner: {
            invalidateCandidates: Effect.void,
            claudeDesktopOrganization: Effect.succeed({
              sections: [
                { id: "cg-fin", name: "FinSearch" },
                { id: "cg-legal", name: "Legal" },
              ],
              sectionBySession: new Map([
                ["in-fin", "cg-fin"],
                ["in-mine", "cg-fin"],
                ["new", "cg-fin"],
                ["legal", "cg-legal"],
                ["not-imported", "cg-legal"],
              ]),
              starred: ["starred", "in-fin"],
            }),
          },
        },
      ).pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed(McpToolAccessTestkit.liveThreadShell(id, { runtimeMode: "auto" })),
            getThreadTitles: () => Effect.succeed({}),
            listActiveShellIndex: () =>
              Effect.succeed(
                [
                  claudeThread("in-fin", { key: "n", section: "fin" }),
                  claudeThread("in-mine", { key: "b", section: "mine" }),
                  claudeThread("legal"),
                  claudeThread("starred"),
                  claudeThread("grandchild", undefined, {
                    spawnedBy: "import:claudeAgent:child",
                  }),
                  claudeThread("child", undefined, { spawnedBy: "import:claudeAgent:in-fin" }),
                  // Unnested by the user, so it stays in its folder.
                  claudeThread("detached", undefined, {
                    spawnedBy: "import:claudeAgent:in-fin",
                    nestParentThreadId: null,
                  }),
                  // Not a Claude import, so the sync leaves it alone.
                  McpToolAccessTestkit.liveThreadShell(ThreadId.make("native")),
                ].map((entry) => ({ mayBeLive: false, hasRemoteTasks: false, ...entry })),
              ),
            dispatch: (command) => {
              dispatched.push(command);
              return Effect.succeed({ sequence: dispatched.length, storedEvents: [] });
            },
          }),
        ),
      ),
    ),
  );
});

it.effect("t3_thread_transfer move hands the thread to ThreadMove; only links may receive", () => {
  const shell = McpToolAccessTestkit.liveThreadShell(threadId);
  const moves: Array<unknown> = [];
  const received: Array<unknown> = [];
  const box = EnvironmentId.make("box");
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (
      name: string,
      args: Record<string, unknown>,
      invocation: McpInvocationContext.McpInvocationScope,
    ) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    const moved = yield* call(
      "t3_thread_transfer",
      { action: "move", toEnvironmentId: box, toProjectId: "box-app" },
      scope,
    );
    expect(moves).toEqual([
      { threadId, targetEnvironmentId: box, targetProjectId: ProjectId.make("box-app") },
    ]);
    expect(moved.structuredContent).toMatchObject({
      threadId: "thread-on-box",
      link: expect.stringContaining("t3-thread://"),
    });
    expect(
      declaredFailure(yield* call("t3_thread_transfer", { action: "move" }, scope)),
    ).toMatchObject({ code: "invalid_request", message: "This action needs `toEnvironmentId`." });

    const receive = {
      projectId: "box-app",
      title: "Moved",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      branch: "feature/x",
      commit: "abc",
      history: [],
    };
    // An agent, or a client that is not a link, neither sees nor reaches it.
    for (const invocation of [scope, clientScope("full-access")]) {
      const refused = yield* Effect.flip(call("t3_thread_receive", receive, invocation));
      expect(refused.message).toContain("not found");
    }
    const linked = clientScope("auto-accept-edits");
    const fromLink = yield* call("t3_thread_receive", receive, {
      ...linked,
      client: { ...linked.client!, linked: true },
    });
    expect(fromLink.isError).toBe(false);
    // The receiving thread runs at the link's modes, stamped with its link.
    expect(received).toMatchObject([
      { runtimeMode: "auto-accept-edits", linkOrigin: { sessionId: "session-1" } },
    ]);
  }).pipe(
    Effect.provide(
      McpHttpServer.layerThreadToolkit.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(AgentSessionImporter.AgentSessionImporter)({}),
            Layer.mock(AgentSessionScanner.AgentSessionScanner)({}),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(ThreadMove.ThreadMove)({
              move: (input) =>
                Effect.sync(() => {
                  moves.push(input);
                  return {
                    environmentId: box,
                    threadId: ThreadId.make("thread-on-box"),
                    projectId: ProjectId.make("box-app"),
                    branch: "feature/x",
                    worktreePath: "/box/wt",
                    commit: "abc",
                    wipCommit: false,
                    context: "history" as const,
                    continued: false,
                  };
                }),
              receive: (_input, modes) =>
                Effect.sync(() => {
                  received.push(modes);
                  return {
                    threadId: ThreadId.make("thread-received"),
                    branch: "feature/x",
                    worktreePath: "/box/wt",
                    context: "history" as const,
                    runId: null,
                  };
                }),
            }),
          ),
        ),
        Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () => Effect.succeed(shell),
            getProjectThreadRecords: () =>
              Effect.succeed(McpToolAccessTestkit.idleThreadProjection(shell)),
          }),
        ),
        Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
        Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
        Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
        Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
        Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
      ),
    ),
  );
});
