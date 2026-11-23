import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RemoteThreadNestParent } from "@t3tools/contracts/settings";
import * as Effect from "effect/Effect";

import * as ServerSettings from "../../../serverSettings.ts";

const MAX_RECORDS = 2000;

/**
 * Records where this machine's sidebar nests a thread in a linked environment: under
 * `parentThreadId` here, or nowhere with null. `ifAbsent` keeps a placement already recorded, so a
 * replayed launch does not undo the user's unnest. The oldest records go past the cap.
 */
function withRemoteThreadNestParent(
  records: ReadonlyArray<RemoteThreadNestParent>,
  entry: RemoteThreadNestParent,
  options: { readonly ifAbsent?: boolean } = {},
): ReadonlyArray<RemoteThreadNestParent> | null {
  const same = (record: RemoteThreadNestParent) =>
    record.environmentId === entry.environmentId && record.threadId === entry.threadId;
  const existing = records.find(same);
  if (
    existing !== undefined &&
    (options.ifAbsent || existing.parentThreadId === entry.parentThreadId)
  )
    return null;
  return [...records.filter((record) => !same(record)), entry].slice(-MAX_RECORDS);
}

export const setRemoteThreadNestParent = Effect.fn("mcp.setRemoteThreadNestParent")(function* (
  child: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
  parentThreadId: ThreadId | null,
  options: { readonly ifAbsent?: boolean } = {},
) {
  const settings = yield* ServerSettings.ServerSettingsService;
  const { remoteThreadNestParents } = yield* settings.getSettings;
  const next = withRemoteThreadNestParent(
    remoteThreadNestParents,
    { environmentId: child.environmentId, threadId: child.threadId, parentThreadId },
    options,
  );
  if (next !== null) yield* settings.updateSettings({ remoteThreadNestParents: next });
});
