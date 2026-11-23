import * as NodeZlib from "node:zlib";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";
import { claudeProjectDirectoryName } from "./threadMovePlan.ts";
import * as ThreadMove from "./ThreadMove.ts";

const here = EnvironmentId.make("laptop");
const box = EnvironmentId.make("box");
const threadId = ThreadId.make("thread-moving");
const sessionId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const at = DateTime.makeUnsafe("2026-11-20T10:00:00.000Z");

interface Harness {
  readonly log: Array<string>;
  readonly calls: Array<{ tool: string; arguments: Record<string, unknown> }>;
  readonly commands: Array<unknown>;
  readonly notices: Array<string>;
  readonly launches: Array<ThreadLaunch.ThreadLaunchInput>;
  readonly histories: Array<ReadonlyArray<unknown>>;
}

const makeHarness = (): Harness => ({
  log: [],
  calls: [],
  commands: [],
  notices: [],
  launches: [],
  histories: [],
});

const layerFor = (
  harness: Harness,
  options: { readonly workspaceRoot: string; readonly claudeHome: string; readonly cwd: string },
) =>
  ThreadMove.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(PeerMcpClient.PeerMcpClient)({
          call: (input) =>
            Effect.sync(() => {
              harness.log.push(input.tool);
              harness.calls.push({ tool: input.tool, arguments: input.arguments });
              return input.tool === "t3_project_list"
                ? {
                    projects: [
                      {
                        id: ProjectId.make("box-other"),
                        title: "Other",
                        repositoryIdentity: { canonicalKey: "github.com/acme/other" },
                      },
                      {
                        id: ProjectId.make("box-app"),
                        title: "App",
                        repositoryIdentity: { canonicalKey: "github.com/acme/app" },
                      },
                    ],
                    nextCursor: null,
                  }
                : {
                    threadId: ThreadId.make("thread-on-box"),
                    branch: "feature/x",
                    worktreePath: "/box/worktrees/app/feature-x",
                    context: "resumed",
                    runId: RunId.make("run-on-box"),
                  };
            }) as never,
        }),
        Layer.mock(PeerLinks.PeerLinks)({
          enabled: Effect.succeed(true),
          get: () => Effect.succeedSome({ label: "box" } as never),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: {
                id: threadId,
                projectId: ProjectId.make("laptop-app"),
                title: "Fix the parser",
                modelSelection: {
                  instanceId: ProviderInstanceId.make("claudeAgent"),
                  model: "claude-opus",
                },
                runtimeMode: "full-access",
                interactionMode: "default",
                worktreePath: options.cwd,
                activeProviderThreadId: "provider-thread",
                deletedAt: null,
                lineage: {
                  parentThreadId: null,
                  relationshipToParent: null,
                  rootThreadId: threadId,
                  spawnedBy: ThreadId.make("thread-parent"),
                },
              },
              messages: [
                {
                  role: "user",
                  text: "Fix it",
                  streaming: false,
                  createdAt: at,
                },
                {
                  role: "assistant",
                  text: "On it",
                  streaming: false,
                  createdAt: at,
                },
                {
                  role: "assistant",
                  text: "Still typ",
                  streaming: true,
                  createdAt: at,
                },
              ],
              runs: [{ id: RunId.make("run-here"), status: "running" }],
              providerThreads: [
                {
                  id: "provider-thread",
                  driver: "claudeAgent",
                  nativeThreadRef: { nativeId: sessionId },
                },
              ],
            } as never),
          dispatch: (command) =>
            Effect.sync(() => {
              harness.log.push(command.type);
              harness.commands.push(command);
              return { sequence: 1, storedEvents: [] } as never;
            }),
          sendToThread: (input) =>
            Effect.sync(() => {
              harness.log.push("send");
              return {
                message: { id: input.messageId },
                projection: {
                  runs: [{ id: RunId.make("run-continued"), userMessageId: input.messageId }],
                },
              } as never;
            }),
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) =>
            Effect.sync(() => {
              harness.log.push("launch");
              harness.launches.push(input);
              return { threadId: ThreadId.make("thread-received"), resumed: false } as never;
            }),
        }),
        Layer.mock(AgentSessionImporter.AgentSessionImporter)({
          writeNotice: (input) =>
            Effect.sync(() => {
              harness.log.push("notice");
              harness.notices.push(input.message);
            }),
          importHistory: (input) =>
            Effect.sync(() => {
              harness.log.push("history");
              harness.histories.push(input.messages);
              return input.messages.length;
            }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) =>
            Effect.succeedSome({ id, title: "App", workspaceRoot: options.workspaceRoot } as never),
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () => Effect.succeed({ canonicalKey: "github.com/acme/app" } as never),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([
            { instanceId: ProviderInstanceId.make("claude-box"), driver: "claudeAgent" },
          ] as never),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(here),
        }),
      ),
    ),
    Layer.provideMerge(
      ServerSettings.ServerSettingsService.layerTest({
        providerInstances: {
          [ProviderInstanceId.make("claudeAgent")]: {
            driver: "claudeAgent",
            config: { homePath: options.claudeHome },
          },
          [ProviderInstanceId.make("claude-box")]: {
            driver: "claudeAgent",
            config: { homePath: options.claudeHome },
          },
        },
      } as never),
    ),
    Layer.provideMerge(
      GitVcsDriver.layer.pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "thread-move-git-" })),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  );

const layerGit = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "thread-move-setup-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  GitVcsDriver.GitVcsDriver.pipe(
    Effect.flatMap((driver) =>
      driver.execute({
        operation: "thread-move-test",
        cwd,
        args,
        env: {
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.com",
        },
      }),
    ),
    Effect.map((result) => result.stdout.trim()),
  );

/** A bare origin and a clone of it with one pushed commit on main. */
const makeRepositories = Effect.fn("makeRepositories")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "thread-move-" });
  const origin = path.join(root, "origin.git");
  const laptop = path.join(root, "laptop");
  yield* git(root, "init", "--bare", "--initial-branch=main", origin);
  yield* git(root, "clone", origin, laptop);
  yield* fileSystem.writeFileString(path.join(laptop, "a.txt"), "one\n");
  yield* git(laptop, "add", "a.txt");
  yield* git(laptop, "commit", "-m", "first");
  yield* git(laptop, "push", "origin", "HEAD:main");
  return { root, origin, laptop, claudeHome: path.join(root, "claude") };
});

describe("ThreadMove.move", () => {
  it.live(
    "pushes the branch with a WIP commit, hands the thread over, then stops and settles it here",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repos = yield* makeRepositories();
        yield* git(repos.laptop, "checkout", "-b", "feature/x");
        yield* fileSystem.writeFileString(path.join(repos.laptop, "a.txt"), "two\n");
        yield* git(repos.laptop, "commit", "-am", "unpushed");
        yield* fileSystem.writeFileString(path.join(repos.laptop, "a.txt"), "three\n");
        yield* fileSystem.writeFileString(path.join(repos.laptop, "new.txt"), "untracked\n");
        const head = yield* git(repos.laptop, "rev-parse", "HEAD");
        const transcriptDir = path.join(
          repos.claudeHome,
          "projects",
          claudeProjectDirectoryName(repos.laptop),
        );
        yield* fileSystem.makeDirectory(transcriptDir, { recursive: true });
        const transcript = `${JSON.stringify({ type: "user", cwd: repos.laptop })}\n`;
        yield* fileSystem.writeFileString(
          path.join(transcriptDir, `${sessionId}.jsonl`),
          transcript,
        );

        const { result, nested } = yield* Effect.gen(function* () {
          const threadMove = yield* ThreadMove.ThreadMove;
          const result = yield* threadMove.move({ threadId, targetEnvironmentId: box });
          const settings = yield* ServerSettings.ServerSettingsService;
          return { result, nested: (yield* settings.getSettings).remoteThreadNestParents };
        }).pipe(
          Effect.provide(
            layerFor(harness, {
              workspaceRoot: repos.laptop,
              claudeHome: repos.claudeHome,
              cwd: repos.laptop,
            }),
          ),
        );

        const pushed = (yield* git(
          repos.laptop,
          "ls-remote",
          "origin",
          "refs/heads/feature/x",
        )).split("\t")[0]!;
        expect(yield* git(repos.laptop, "rev-parse", `${pushed}^`)).toBe(head);
        expect(yield* git(repos.laptop, "show", `${pushed}:a.txt`)).toBe("three");
        expect(yield* git(repos.laptop, "show", `${pushed}:new.txt`)).toBe("untracked");
        // The checkout here is left as it was.
        expect(yield* git(repos.laptop, "rev-parse", "HEAD")).toBe(head);
        expect(yield* git(repos.laptop, "status", "--porcelain")).toBe("M a.txt\n?? new.txt");

        expect(result).toEqual({
          environmentId: box,
          threadId: ThreadId.make("thread-on-box"),
          projectId: ProjectId.make("box-app"),
          branch: "feature/x",
          worktreePath: "/box/worktrees/app/feature-x",
          commit: pushed,
          wipCommit: true,
          context: "resumed",
          continued: true,
        });
        // Nothing here stops until the other side has taken the thread.
        expect(harness.log).toEqual([
          "t3_project_list",
          "t3_thread_receive",
          "run.interrupt",
          "notice",
          "thread.settle",
        ]);
        const received = harness.calls[1]!.arguments;
        expect(received).toMatchObject({
          projectId: "box-app",
          title: "Fix the parser",
          branch: "feature/x",
          commit: pushed,
          history: [
            { role: "user", text: "Fix it", createdAt: DateTime.formatIso(at) },
            { role: "assistant", text: "On it", createdAt: DateTime.formatIso(at) },
          ],
          claudeSession: { sessionId, cwd: repos.laptop },
        });
        expect(received.message).toContain(pushed.slice(0, 12));
        const session = received.claudeSession as { transcript: string };
        expect(NodeZlib.gunzipSync(Buffer.from(session.transcript, "base64")).toString()).toBe(
          transcript,
        );
        expect(harness.notices[0]).toContain("t3-thread://");
        // It nests where this one did.
        expect(nested).toEqual([
          { environmentId: box, threadId: "thread-on-box", parentThreadId: "thread-parent" },
        ]);
      }).pipe(Effect.scoped, Effect.provide(layerGit));
    },
  );

  it.live("moves nothing when the branch cannot be pushed", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repos = yield* makeRepositories();
      // Someone else pushed feature/x meanwhile.
      const other = path.join(repos.root, "other");
      yield* git(repos.root, "clone", repos.origin, other);
      yield* fileSystem.writeFileString(path.join(other, "b.txt"), "theirs\n");
      yield* git(other, "add", "b.txt");
      yield* git(other, "commit", "-m", "theirs");
      yield* git(other, "push", "origin", "HEAD:refs/heads/feature/x");
      yield* git(repos.laptop, "checkout", "-b", "feature/x");
      yield* fileSystem.writeFileString(path.join(repos.laptop, "a.txt"), "mine\n");
      yield* git(repos.laptop, "commit", "-am", "mine");

      const exit = yield* Effect.gen(function* () {
        const threadMove = yield* ThreadMove.ThreadMove;
        return yield* threadMove.move({
          threadId,
          targetEnvironmentId: box,
          targetProjectId: ProjectId.make("box-app"),
        });
      }).pipe(
        Effect.provide(
          layerFor(harness, {
            workspaceRoot: repos.laptop,
            claudeHome: repos.claudeHome,
            cwd: repos.laptop,
          }),
        ),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("Could not push feature/x to origin");
      expect(harness.log).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layerGit));
  });
});

describe("ThreadMove.receive", () => {
  it.live(
    "checks the pushed commit out in a new worktree and resumes the Claude session there",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repos = yield* makeRepositories();
        yield* git(repos.laptop, "checkout", "-b", "feature/x");
        yield* fileSystem.writeFileString(path.join(repos.laptop, "a.txt"), "moved\n");
        yield* git(repos.laptop, "commit", "-am", "work");
        const commit = yield* git(repos.laptop, "rev-parse", "HEAD");
        yield* git(repos.laptop, "push", "origin", "HEAD:refs/heads/feature/x");
        const boxRoot = path.join(repos.root, "box");
        yield* git(repos.root, "clone", repos.origin, boxRoot);
        // The box already has a feature/x of its own, which must survive.
        yield* git(boxRoot, "branch", "feature/x", "main");
        const transcript = [
          JSON.stringify({ type: "user", cwd: "/Users/f/app" }),
          JSON.stringify({ type: "assistant", cwd: "/Users/f/app/web" }),
          "",
        ].join("\n");

        const received = yield* Effect.gen(function* () {
          const threadMove = yield* ThreadMove.ThreadMove;
          return yield* threadMove.receive(
            {
              projectId: ProjectId.make("box-app"),
              title: "Fix the parser",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: "claude-opus",
              },
              branch: "feature/x",
              commit,
              history: [{ role: "user", text: "Fix it", createdAt: DateTime.formatIso(at) }],
              claudeSession: {
                sessionId,
                cwd: "/Users/f/app",
                transcript: NodeZlib.gzipSync(Buffer.from(transcript)).toString("base64"),
              },
              message: "Continue.",
            },
            { runtimeMode: "auto-accept-edits", interactionMode: "default", linkOrigin: undefined },
          );
        }).pipe(
          Effect.provide(
            layerFor(harness, {
              workspaceRoot: boxRoot,
              claudeHome: repos.claudeHome,
              cwd: boxRoot,
            }),
          ),
        );

        expect(received).toMatchObject({
          threadId: "thread-received",
          branch: "feature/x-2",
          context: "resumed",
          runId: "run-continued",
        });
        expect(yield* git(received.worktreePath, "rev-parse", "HEAD")).toBe(commit);
        expect(yield* git(boxRoot, "rev-parse", "feature/x")).toBe(
          yield* git(boxRoot, "rev-parse", "main"),
        );
        // The instance here is picked by driver when the one there has no twin.
        expect(harness.launches[0]).toMatchObject({
          projectId: "box-app",
          modelSelection: { instanceId: "claude-box", model: "claude-opus" },
          runtimeMode: "auto-accept-edits",
          workspaceStrategy: {
            type: "existing_worktree",
            worktreePath: received.worktreePath,
            branch: "feature/x-2",
          },
          importedNativeThread: { ref: { driver: "claudeAgent", nativeId: sessionId } },
        });
        // History lands before the first turn, so a turn never runs without it.
        expect(harness.log).toEqual(["launch", "history", "send"]);
        expect(harness.histories[0]).toHaveLength(1);
        const written = yield* fileSystem.readFileString(
          path.join(
            repos.claudeHome,
            "projects",
            claudeProjectDirectoryName(received.worktreePath),
            `${sessionId}.jsonl`,
          ),
        );
        expect(
          written.split("\n").map((line) => (line === "" ? null : JSON.parse(line).cwd)),
        ).toEqual([received.worktreePath, `${received.worktreePath}/web`, null]);
      }).pipe(Effect.scoped, Effect.provide(layerGit));
    },
  );

  it.live("refuses a commit the shared remote does not have", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const repos = yield* makeRepositories();
      const exit = yield* Effect.gen(function* () {
        const threadMove = yield* ThreadMove.ThreadMove;
        return yield* threadMove.receive(
          {
            projectId: ProjectId.make("box-app"),
            title: "Fix the parser",
            modelSelection: { instanceId: ProviderInstanceId.make("claude-box"), model: "m" },
            branch: "main",
            commit: "0123456789abcdef0123456789abcdef01234567",
            history: [],
          },
          { runtimeMode: "auto", interactionMode: "default", linkOrigin: undefined },
        );
      }).pipe(
        Effect.provide(
          layerFor(harness, {
            workspaceRoot: repos.laptop,
            claudeHome: repos.claudeHome,
            cwd: repos.laptop,
          }),
        ),
        Effect.exit,
      );
      expect(JSON.stringify(exit)).toContain("Could not find commit 0123456789ab");
      expect(harness.launches).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layerGit));
  });
});
