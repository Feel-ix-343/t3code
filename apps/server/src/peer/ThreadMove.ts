import * as NodeZlib from "node:zlib";

import {
  ClaudeSettings,
  CommandId,
  MessageId,
  OrchestratorMcpFailure,
  type ProjectId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadMoveError,
  type ThreadMoveInput,
  type ThreadMoveResult,
  type OrchestrationV2LinkOrigin,
  threadNestParentId,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Tool from "effect/ai/Tool";

import { setRemoteThreadNestParent } from "../mcp/toolkits/thread/remoteNesting.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";
import {
  claudeProjectDirectoryName,
  continueMessage,
  MAX_EXPANDED_TRANSCRIPT_BYTES,
  MAX_MOVED_TRANSCRIPT_BYTES,
  movedBranchName,
  movedHistory,
  rehomeClaudeTranscript,
  type ThreadReceiveInput,
  ThreadReceiveResult,
} from "./threadMovePlan.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});
const WIP_IDENTITY = {
  GIT_AUTHOR_NAME: "T3 Code",
  GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
  GIT_COMMITTER_NAME: "T3 Code",
  GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
};

/** The receiving side's own modes and link, as `McpToolAccess.startsThreads` worked them out. */
export interface ReceiveModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly linkOrigin: OrchestrationV2LinkOrigin | undefined;
}

/**
 * Moves a thread to a linked environment, where it continues: its branch and uncommitted work
 * are pushed to the shared remote, the environment there checks them out in a new worktree and
 * starts a thread with this one's history (and, for Claude Code, its session), and only then is
 * this one stopped and settled with a link to it.
 */
export class ThreadMove extends Context.Service<
  ThreadMove,
  {
    readonly move: (input: ThreadMoveInput) => Effect.Effect<ThreadMoveResult, ThreadMoveError>;
    /** `t3_thread_receive`: the other side of `move`, run for a linked environment. */
    readonly receive: (
      input: ThreadReceiveInput,
      modes: ReceiveModes,
    ) => Effect.Effect<Omit<ThreadReceiveResult, "link">, OrchestratorMcpFailure>;
  }
>()("t3/peer/ThreadMove") {}

const failure = (message: string) => new ThreadMoveError({ message });

const make = Effect.gen(function* () {
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const links = yield* PeerLinks.PeerLinks;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const importer = yield* AgentSessionImporter.AgentSessionImporter;
  const projects = yield* ProjectService.ProjectService;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const settings = yield* ServerSettings.ServerSettingsService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const hereId = yield* ServerEnvironment.ServerEnvironment.pipe(
    Effect.flatMap((environment) => environment.getEnvironmentId),
  );

  const runGit = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    env?: NodeJS.ProcessEnv,
  ) =>
    git
      .execute({
        operation: `ThreadMove.${operation}`,
        cwd,
        args,
        allowNonZeroExit: true,
        ...(env ? { env } : {}),
      })
      .pipe(
        Effect.map((result) => ({
          ok: result.exitCode === 0,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
        })),
      );
  const gitOrFail = <E>(
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    onError: (detail: string) => E,
    env?: NodeJS.ProcessEnv,
  ) =>
    runGit(operation, cwd, args, env).pipe(
      Effect.mapError((error) => onError(error.message)),
      Effect.flatMap((result) =>
        result.ok
          ? Effect.succeed(result.stdout)
          : Effect.fail(onError(result.stderr || result.stdout)),
      ),
    );

  /** Where an instance's Claude Code keeps its sessions on this machine. */
  const claudeConfigDir = Effect.fn("ThreadMove.claudeConfigDir")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const instance = (yield* settings.getSettings.pipe(Effect.orDie)).providerInstances[instanceId];
    const config = Option.getOrElse(
      decodeClaudeSettings(instance?.config ?? {}),
      () => DEFAULT_CLAUDE_SETTINGS,
    );
    const environment = yield* mergeProviderInstanceEnvironment(
      instance?.environment,
      yield* HostProcess.Environment,
    );
    return yield* resolveClaudeHomePath(config, environment).pipe(
      Effect.provideService(Path.Path, path),
    );
  });

  /** The session's transcript, gzipped and base64-encoded, or null when it is not on this machine or too big. */
  const readClaudeTranscript = Effect.fn("ThreadMove.readClaudeTranscript")(function* (
    instanceId: ProviderInstanceId,
    sessionId: string,
    cwd: string,
  ) {
    const projectsDir = path.join(yield* claudeConfigDir(instanceId), "projects");
    const fileName = `${sessionId}.jsonl`;
    const direct = path.join(projectsDir, claudeProjectDirectoryName(cwd), fileName);
    let found: string | null = (yield* fileSystem
      .exists(direct)
      .pipe(Effect.orElseSucceed(() => false)))
      ? direct
      : null;
    // Sessions that ran in a subdirectory live under that directory's name.
    if (found === null) {
      for (const directory of yield* fileSystem
        .readDirectory(projectsDir)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))) {
        const candidate = path.join(projectsDir, directory, fileName);
        if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
          found = candidate;
          break;
        }
      }
    }
    if (found === null) return null;
    const text = yield* fileSystem.readFileString(found).pipe(Effect.orElseSucceed(() => null));
    if (text === null) return null;
    const encoded = NodeZlib.gzipSync(Buffer.from(text, "utf8")).toString("base64");
    return encoded.length > MAX_MOVED_TRANSCRIPT_BYTES ? null : encoded;
  });

  /** The project there with this repository, unless the caller named one. */
  const resolveRemoteProject = Effect.fn("ThreadMove.resolveRemoteProject")(function* (
    call: <A>(
      tool: string,
      args: Record<string, unknown>,
      success: Schema.Decoder<A>,
    ) => Effect.Effect<A, OrchestratorMcpFailure>,
    workspaceRoot: string,
  ) {
    const key = (yield* repositoryIdentities.resolve(workspaceRoot))?.canonicalKey;
    if (key === undefined) {
      return yield* failure(
        "This thread's project has no repository remote to match there. Pick the project there.",
      );
    }
    const listTool: typeof ProjectToolkit.tools.t3_project_list =
      ProjectToolkit.tools.t3_project_list;
    const matches: Array<{ readonly id: ProjectId; readonly title: string }> = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page: Tool.Success<typeof listTool> = yield* call(
        listTool.name,
        { cursor, limit: 100 },
        listTool.successSchema as Schema.Decoder<Tool.Success<typeof listTool>>,
      ).pipe(Effect.mapError((error) => failure(error.message)));
      matches.push(
        ...page.projects.filter((project) => project.repositoryIdentity?.canonicalKey === key),
      );
      cursor = page.nextCursor;
    }
    if (matches.length === 1) return matches[0]!.id;
    return yield* failure(
      matches.length === 0
        ? `No project there has this repository (${key}). Add it there first.`
        : `Several projects there have this repository: ${matches.map((project) => project.title).join(", ")}. Pick one.`,
    );
  });

  /**
   * The commit that holds the checkout as it is: HEAD, or a WIP commit on top of it with the
   * uncommitted and untracked changes. Built in a scratch index, so the checkout is untouched.
   */
  const snapshotCommit = Effect.fn("ThreadMove.snapshotCommit")(function* (
    cwd: string,
    title: string,
  ) {
    const fail = (step: string) => (detail: string) =>
      failure(`Could not ${step} in ${cwd}: ${detail}`);
    const head = yield* gitOrFail("head", cwd, ["rev-parse", "HEAD"], fail("read HEAD"));
    const status = yield* gitOrFail(
      "status",
      cwd,
      ["status", "--porcelain", "--untracked-files=all"],
      fail("read the status"),
    );
    if (status === "") return { commit: head, wip: false };
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fileSystem
          .makeTempDirectoryScoped({ prefix: "t3-move-" })
          .pipe(Effect.mapError((error) => failure(error.message)));
        const env = { GIT_INDEX_FILE: path.join(directory, "index") };
        yield* gitOrFail("read-tree", cwd, ["read-tree", "HEAD"], fail("stage changes"), env);
        yield* gitOrFail("add", cwd, ["add", "-A"], fail("stage changes"), env);
        const tree = yield* gitOrFail(
          "write-tree",
          cwd,
          ["write-tree"],
          fail("stage changes"),
          env,
        );
        const email = yield* runGit("identity", cwd, ["config", "user.email"]).pipe(
          Effect.orElseSucceed(() => ({ ok: false, stdout: "", stderr: "" })),
        );
        const commit = yield* gitOrFail(
          "commit-tree",
          cwd,
          ["commit-tree", tree, "-p", head, "-m", `WIP: moved from T3 Code (${title})`],
          fail("commit the uncommitted changes"),
          email.ok && email.stdout !== "" ? env : { ...env, ...WIP_IDENTITY },
        );
        return { commit, wip: true };
      }),
    );
  });

  const move: ThreadMove["Service"]["move"] = Effect.fn("ThreadMove.move")(function* (input) {
    if (input.targetEnvironmentId === hereId) return yield* failure("The thread is already here.");
    if (!(yield* links.enabled)) {
      return yield* failure("Linked environments is off here. Turn it on in Settings → Labs.");
    }
    const link = yield* links.get(input.targetEnvironmentId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError((error) => failure(error.message)),
    );
    if (link === undefined) return yield* failure("That environment is not linked here.");

    const records = yield* threads
      .getThreadRecords(input.threadId, ["messages", "runs", "providerThreads"])
      .pipe(Effect.mapError(() => failure("The thread was not found.")));
    const { thread } = records;
    if (thread.deletedAt !== null) return yield* failure("The thread was deleted.");
    const project = yield* projects.getById(thread.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    if (project === undefined) return yield* failure("The thread's project was not found.");
    const cwd = thread.worktreePath ?? project.workspaceRoot;

    const sender = { environmentId: hereId, threadId: thread.id, title: thread.title };
    // The thread's own modes travel as its limits; the link's access caps them there too.
    const limits = { runtimeMode: thread.runtimeMode, interactionMode: thread.interactionMode };
    const call = <A>(tool: string, args: Record<string, unknown>, success: Schema.Decoder<A>) =>
      peers.call({
        environmentId: input.targetEnvironmentId,
        tool,
        arguments: args,
        limits,
        sender,
        success,
      }) as Effect.Effect<A, OrchestratorMcpFailure>;

    const projectId =
      input.targetProjectId ?? (yield* resolveRemoteProject(call, project.workspaceRoot));

    // A submodule's uncommitted files are not part of the superproject's snapshot.
    const dirtySubmodules = yield* runGit("submodules", cwd, [
      "submodule",
      "foreach",
      "--quiet",
      "--recursive",
      'test -z "$(git status --porcelain)" || echo "$displaypath"',
    ]).pipe(Effect.orElseSucceed(() => ({ ok: true, stdout: "", stderr: "" })));
    if (dirtySubmodules.stdout !== "") {
      return yield* failure(
        `Commit or discard the changes in ${dirtySubmodules.stdout.split("\n").join(", ")} first: a move carries only the main repository's uncommitted work.`,
      );
    }
    // The work goes through the remote the repository is matched by, which both sides reach.
    const snapshot = yield* snapshotCommit(cwd, thread.title);
    const identity = yield* repositoryIdentities.resolve(cwd);
    const remote =
      identity?.locator.remoteName ??
      (yield* git
        .resolvePrimaryRemoteName(cwd)
        .pipe(Effect.mapError(() => failure("The checkout has no remote to push its work to."))));
    const currentBranch = yield* runGit("branch", cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
      Effect.map((result) => (result.ok ? result.stdout : null)),
      Effect.orElseSucceed(() => null),
    );
    const branch = movedBranchName({
      branch: currentBranch,
      defaultBranch: yield* git
        .resolveDefaultBranchName(cwd, remote)
        .pipe(Effect.orElseSucceed(() => null)),
      threadId: thread.id,
    });
    yield* gitOrFail(
      "push",
      cwd,
      ["push", remote, `${snapshot.commit}:refs/heads/${branch}`],
      (detail) =>
        failure(
          `Could not push ${branch} to ${remote}, so nothing moved: ${detail}. Bring ${branch} up to date with ${remote} and try again.`,
        ),
    );

    const providerThread = records.providerThreads.find(
      (candidate) => candidate.id === thread.activeProviderThreadId,
    );
    const sessionId =
      providerThread?.driver === CLAUDE_DRIVER
        ? providerThread.nativeThreadRef?.nativeId
        : undefined;
    const transcript =
      sessionId == null
        ? null
        : yield* readClaudeTranscript(thread.modelSelection.instanceId, sessionId, cwd);
    const driver =
      providerThread?.driver ??
      (yield* providers.getProviders).find(
        (provider) => provider.instanceId === thread.modelSelection.instanceId,
      )?.driver;
    const activeRun = records.runs.filter(ThreadManagement.isActiveRun).at(-1);
    const message =
      input.message ??
      (activeRun === undefined
        ? undefined
        : continueMessage({ wipCommit: snapshot.wip ? snapshot.commit : null }));

    const received = yield* call(
      "t3_thread_receive",
      {
        projectId,
        title: thread.title,
        modelSelection: thread.modelSelection,
        ...(driver === undefined ? {} : { driver }),
        ...(identity === null ? {} : { repository: identity.canonicalKey }),
        branch,
        commit: snapshot.commit,
        history: movedHistory(records.messages, DateTime.formatIso),
        ...(sessionId == null || transcript === null
          ? {}
          : { claudeSession: { sessionId, cwd, transcript } }),
        ...(message === undefined ? {} : { message }),
      },
      ThreadReceiveResult,
    ).pipe(
      Effect.mapError((error) =>
        failure(`${link.label} did not take the thread: ${error.message}`),
      ),
    );

    // From here the thread lives there; what follows only tidies this side.
    const tidy = <A, E, R>(step: string, effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.catchCause((cause) => Effect.logWarning(`thread-move.${step}-failed`, { cause })),
      );
    const commandId = (suffix: string) =>
      random.uuidV4().pipe(Effect.map((id) => CommandId.make(`thread-move:${id}:${suffix}`)));
    if (activeRun !== undefined) {
      yield* tidy(
        "interrupt",
        threads.dispatch({
          type: "run.interrupt",
          commandId: yield* commandId("interrupt"),
          threadId: thread.id,
          runId: activeRun.id,
          reason: `Moved to ${link.label}.`,
        }),
      );
    }
    yield* tidy(
      "notice",
      importer.writeNotice({
        threadId: thread.id,
        runId: records.runs.at(-1)?.id ?? null,
        key: `thread-move:${received.threadId}`,
        title: "Moved",
        message: `Moved to ${link.label}, where it continues: ${formatThreadLink({ environmentId: input.targetEnvironmentId, threadId: received.threadId }, thread.title)}. Its work was pushed to ${branch} (${snapshot.commit.slice(0, 12)}${snapshot.wip ? ", with a WIP commit of the uncommitted changes" : ""}).`,
      }),
    );
    yield* tidy(
      "settle",
      threads.dispatch({
        type: "thread.settle",
        commandId: yield* commandId("settle"),
        threadId: thread.id,
      }),
    );
    // It shows where this one did: under the same parent, when it has one.
    const parent = threadNestParentId(thread.lineage);
    if (parent !== null) {
      yield* tidy(
        "nest",
        setRemoteThreadNestParent(
          { environmentId: input.targetEnvironmentId, threadId: received.threadId },
          parent,
        ).pipe(Effect.provideService(ServerSettings.ServerSettingsService, settings)),
      );
    }
    return {
      environmentId: input.targetEnvironmentId,
      threadId: received.threadId,
      projectId,
      branch: received.branch,
      worktreePath: received.worktreePath,
      commit: snapshot.commit,
      wipCommit: snapshot.wip,
      context: received.context,
      continued: received.runId !== null,
    };
  });

  const receive: ThreadMove["Service"]["receive"] = Effect.fn("ThreadMove.receive")(
    function* (input, modes) {
      const refuse = (message: string) =>
        new OrchestratorMcpFailure({ code: "invalid_request", message });
      const project = yield* projects.getById(input.projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      if (project === undefined) return yield* refuse("The project was not found.");
      const root = project.workspaceRoot;
      const gitFailure = (step: string) => (detail: string) =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: `Could not ${step} in ${root}: ${detail}`,
        });

      const available = yield* providers.getProviders;
      const instance =
        available.find((provider) => provider.instanceId === input.modelSelection.instanceId) ??
        available.find(
          (provider) =>
            provider.driver ===
            (input.driver ?? (input.claudeSession === undefined ? undefined : CLAUDE_DRIVER)),
        );
      if (instance === undefined) {
        return yield* refuse(
          `No provider instance ${input.modelSelection.instanceId} here to continue the thread.`,
        );
      }
      const modelSelection = { ...input.modelSelection, instanceId: instance.instanceId };

      yield* gitOrFail("branch-name", root, ["check-ref-format", "--branch", input.branch], () =>
        refuse(`${input.branch} is not a branch name.`),
      );
      // The remote the repository is matched by here, which the work was pushed to there.
      const identity = yield* repositoryIdentities.resolve(root);
      const remote =
        identity !== null &&
        (input.repository === undefined || identity.canonicalKey === input.repository)
          ? identity.locator.remoteName
          : yield* git
              .resolvePrimaryRemoteName(root)
              .pipe(
                Effect.mapError(() =>
                  refuse("The project here has no remote to fetch the work from."),
                ),
              );
      yield* gitOrFail(
        "fetch",
        root,
        ["fetch", remote, `+refs/heads/${input.branch}:refs/remotes/${remote}/${input.branch}`],
        gitFailure(`fetch ${input.branch}`),
      );
      yield* gitOrFail(
        "verify",
        root,
        ["cat-file", "-e", `${input.commit}^{commit}`],
        gitFailure(`find commit ${input.commit.slice(0, 12)} on ${input.branch}`),
      );
      // A branch of that name here may hold other work, so the checkout takes the next free name.
      let localBranch = input.branch;
      for (let suffix = 2; ; suffix++) {
        const taken = yield* runGit("branch-exists", root, [
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/heads/${localBranch}`,
        ]).pipe(
          Effect.map((result) => result.ok),
          Effect.orElseSucceed(() => false),
        );
        if (!taken) break;
        localBranch = `${input.branch}-${suffix}`;
      }
      const worktree = yield* git
        .createWorktree({
          cwd: root,
          refName: input.commit,
          newRefName: localBranch,
          baseRefName: `${remote}/${input.branch}`,
          path: null,
        })
        .pipe(Effect.mapError((error) => gitFailure("create a worktree")(error.message)));
      const worktreePath = worktree.worktree.path;
      yield* git
        .setBranchUpstream({
          cwd: worktreePath,
          branch: localBranch,
          remoteName: remote,
          remoteBranch: input.branch,
        })
        .pipe(Effect.ignore);

      // Claude Code finds a session to resume under its cwd's folder, so the transcript goes there.
      let resumed = false;
      if (input.claudeSession !== undefined && instance.driver === CLAUDE_DRIVER) {
        const session = input.claudeSession;
        resumed = yield* Effect.gen(function* () {
          const text = NodeZlib.gunzipSync(Buffer.from(session.transcript, "base64"), {
            maxOutputLength: MAX_EXPANDED_TRANSCRIPT_BYTES,
          }).toString("utf8");
          const directory = path.join(
            yield* claudeConfigDir(instance.instanceId),
            "projects",
            claudeProjectDirectoryName(worktreePath),
          );
          yield* fileSystem.makeDirectory(directory, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(directory, `${session.sessionId}.jsonl`),
            rehomeClaudeTranscript(text, session.cwd, worktreePath),
          );
          return true;
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("thread-move.transcript-write-failed", { cause }).pipe(
              Effect.as(false),
            ),
          ),
        );
      }

      const commandId = CommandId.make(`thread-move:${yield* random.uuidV4()}`);
      const continuation = input.message?.trim() ? input.message : undefined;
      const worktreeStrategy = {
        type: "existing_worktree" as const,
        worktreePath,
        branch: localBranch,
      };
      const launched = yield* launches
        .launch({
          commandId,
          projectId: input.projectId,
          title: input.title,
          titleRenamed: true,
          modelSelection,
          runtimeMode: modes.runtimeMode,
          interactionMode: modes.interactionMode,
          // A turn to continue takes the worktree with its own preparation below, so the setup
          // script runs once, before that turn.
          workspaceStrategy: continuation === undefined ? worktreeStrategy : { type: "root" },
          ...(resumed && input.claudeSession !== undefined
            ? {
                importedNativeThread: {
                  ref: {
                    driver: CLAUDE_DRIVER,
                    nativeId: input.claudeSession.sessionId,
                    strength: "strong" as const,
                  },
                },
              }
            : {}),
          createdBy: "agent",
          creationSource: "mcp",
          ...(modes.linkOrigin === undefined ? {} : { linkOrigin: modes.linkOrigin }),
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
          ),
        );
      // Before any turn: without a session to resume, the first one gets this history as context.
      yield* importer.importHistory({ threadId: launched.threadId, messages: input.history }).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "Could not write the thread's history.",
            }),
        ),
      );
      let runId: ThreadReceiveResult["runId"] = null;
      if (continuation !== undefined) {
        const continueCommandId = CommandId.make(`${commandId}:continue`);
        const accepted = yield* threads
          .dispatch({
            type: "message.dispatch",
            commandId: continueCommandId,
            threadId: launched.threadId,
            messageId: MessageId.make(`${commandId}:continue`),
            text: continuation,
            attachments: [],
            modelSelection,
            dispatchMode: { type: "defer_start", workspaceStrategy: worktreeStrategy },
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(
            Effect.mapError(
              () =>
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: "Could not start the thread's next turn.",
                }),
            ),
          );
        const created = accepted.storedEvents.find((stored) => stored.event.type === "run.created");
        if (created?.event.type === "run.created") {
          runId = created.event.payload.id;
          yield* launches.prepareRun({
            commandId: continueCommandId,
            threadId: launched.threadId,
            runId,
          });
        }
      }
      return {
        threadId: launched.threadId,
        branch: localBranch,
        worktreePath,
        context: resumed ? ("resumed" as const) : ("history" as const),
        runId,
      };
    },
  );

  return ThreadMove.of({ move, receive });
});

export const layer = Layer.effect(ThreadMove, make);
