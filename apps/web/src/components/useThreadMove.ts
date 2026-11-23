import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  linkedEnvironmentNames,
  offersLinkedEnvironments,
} from "@t3tools/client-runtime/link-request";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { m } from "../i18n/messages";
import { readLocalApi } from "../localApi";
import { useServerConfigs } from "../state/entities";
import { environmentIdsKey } from "../state/environmentAtomList";
import { useEnvironmentIdentities } from "../state/environments";
import { peerLinkEnvironment, peerLinkNamesAtom } from "../state/peerLinks";
import { useAtomCommand } from "../state/use-atom-command";
import { toastManager } from "./ui/toast";

export interface ThreadMoveTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/** The linked environments each environment here can move its threads to. */
export function useThreadMoveTargets(): ReadonlyMap<
  EnvironmentId,
  ReadonlyArray<ThreadMoveTarget>
> {
  const serverConfigs = useServerConfigs();
  const identities = useEnvironmentIdentities();
  const hosts = [...serverConfigs].flatMap(([environmentId, config]) =>
    offersLinkedEnvironments(config) ? [environmentId] : [],
  );
  const lists = useAtomValue(peerLinkNamesAtom(environmentIdsKey(hosts)));
  return new Map(
    hosts.map((environmentId, index) => {
      const list = lists[index];
      const names = linkedEnvironmentNames({
        links: list?._tag === "Success" ? list.value.links : [],
        environments: identities,
      });
      return [environmentId, [...names].map(([id, label]) => ({ environmentId: id, label }))];
    }),
  );
}

/** Asks, then moves a thread to a linked environment, reporting the outcome in a toast. */
export function useMoveThread() {
  const gt = useGT();
  const move = useAtomCommand(peerLinkEnvironment.moveThread, {
    label: "move thread",
    reportFailure: false,
  });
  return async (
    thread: {
      readonly environmentId: EnvironmentId;
      readonly id: ThreadId;
      readonly title: string;
    },
    target: ThreadMoveTarget,
  ) => {
    const api = readLocalApi();
    if (!api) return;
    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(
        [
          gt('Move "{title}" to {environment}?', {
            title: thread.title,
            environment: target.label,
          }),
          gt(
            "Its branch and uncommitted changes are pushed to the repository's remote and checked out there in a new worktree. The conversation continues there, and a running turn here stops.",
          ),
        ].join("\n"),
      ),
    );
    if (confirmed._tag === "Failure" || !confirmed.value) return;
    const pending = toastManager.add({
      type: "loading",
      title: gt("Moving to {environment}…", { environment: target.label }),
      timeout: 0,
    });
    const result = await move({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, targetEnvironmentId: target.environmentId },
    });
    toastManager.close(pending);
    if (result._tag === "Success") {
      const { branch, wipCommit } = result.value;
      toastManager.add({
        type: "success",
        title: gt("Moved to {environment}", { environment: target.label }),
        description: wipCommit
          ? gt("It continues on {branch}, with uncommitted changes in a WIP commit.", { branch })
          : gt("It continues on {branch}.", { branch }),
      });
      return;
    }
    toastManager.add({
      type: "error",
      title: gt("Could not move the thread"),
      description:
        thrownErrorMessage(squashAtomCommandFailure(result), m) ?? gt("An error occurred."),
    });
  };
}
