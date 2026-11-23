import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  isListedThreadLineage,
  type RunId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { msg } from "gt-react";

import { prepareRevertedMessageAttachments } from "../components/ChatView.logic";
import { restoreMessageToComposer } from "../components/chat/chatViewSend";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { m } from "../i18n/messages";
import { newThreadId } from "../lib/utils";
import { assetEnvironment } from "../state/assets";
import { readThreadShell, waitForThreadShell } from "../state/entities";
import { readPreparedConnection } from "../state/session";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { buildThreadRouteParams } from "../threadRoutes";
import type { ChatMessage } from "../types";
import { useStableCallback } from "./useStableCallback";

export interface ForkThreadRequest {
  /** The thread to fork; a timeline row's source thread for inherited history. */
  readonly sourceThreadRef: ScopedThreadRef;
  /** The last run the fork keeps. Absent keeps through the latest stable run. */
  readonly runId?: RunId;
  /** Gives the fork its own worktree from the source's branch. */
  readonly newWorktree?: boolean;
  /** Put back in the fork's composer, as "Edit from here" does in place. */
  readonly message?: ChatMessage;
}

/** Subagents and side chats live inside their parent; a fork of one would surface it. */
export function canForkThreadShell(thread: Pick<EnvironmentThreadShell, "lineage">): boolean {
  return isListedThreadLineage(thread.lineage);
}

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: thrownErrorMessage(error, m) ?? m(msg("An error occurred.")),
    }),
  );
}

/** Forks a thread into a new one nested under it and opens the fork. Resolves true once open. */
export function useForkThread() {
  const navigate = useNavigate();
  const forkThread = useAtomCommand(threadEnvironment.fork, { reportFailure: false });
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });

  return useStableCallback(async (request: ForkThreadRequest): Promise<boolean> => {
    const { sourceThreadRef, message } = request;
    const { environmentId } = sourceThreadRef;
    const source = readThreadShell(sourceThreadRef);
    if (source === null) {
      failureToast(
        m(msg("Could not fork thread")),
        new Error(m(msg("This thread has not loaded yet."))),
      );
      return false;
    }
    let files: ReadonlyArray<File> = [];
    if (message !== undefined) {
      const connection = readPreparedConnection(environmentId);
      if (!connection) {
        failureToast(
          m(msg("Could not fork thread")),
          new Error(m(msg("The environment is not connected."))),
        );
        return false;
      }
      try {
        files = await prepareRevertedMessageAttachments({
          message,
          environmentId,
          httpBaseUrl: connection.httpBaseUrl,
          createAssetUrl,
        });
      } catch (error) {
        failureToast(m(msg("Could not fork thread")), error);
        return false;
      }
    }
    const targetThreadId: ThreadId = newThreadId();
    const targetThreadRef = scopeThreadRef(environmentId, targetThreadId);
    const result = await forkThread({
      environmentId,
      input: {
        sourceThreadId: sourceThreadRef.threadId,
        targetThreadId,
        ...(request.runId === undefined ? {} : { runId: request.runId }),
        ...(request.newWorktree && source.branch
          ? {
              newWorktree: {
                projectId: source.projectId,
                baseRef: source.branch,
                title: source.title,
                modelSelection: source.modelSelection,
                runtimeMode: source.runtimeMode,
                interactionMode: source.interactionMode,
              },
            }
          : {}),
      },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        failureToast(m(msg("Could not fork thread")), squashAtomCommandFailure(result));
      }
      return false;
    }
    if (result.value.worktreeFailure !== undefined) {
      failureToast(
        m(msg("Forked, but its worktree could not be set up")),
        result.value.worktreeFailure,
      );
    }
    if (!(await waitForThreadShell(targetThreadRef))) {
      failureToast(
        m(msg("Could not open fork")),
        new Error(
          m(
            msg(
              "The fork was created, but its thread data did not reach this client. Reconnect and try opening it from the sidebar.",
            ),
          ),
        ),
      );
      return false;
    }
    if (message !== undefined) restoreMessageToComposer(targetThreadRef, message, files);
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(targetThreadRef),
    });
    return true;
  });
}
