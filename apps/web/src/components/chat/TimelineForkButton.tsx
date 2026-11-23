import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { canForkProjectedAssistantItem } from "@t3tools/client-runtime/state/thread-workflows";
import { useGT } from "gt-react";
import { GitForkIcon } from "lucide-react";
import { use, useState } from "react";

import { cn } from "~/lib/utils";
import { useV2ItemSupport } from "../../state/v2ItemSupport";
import type { ChatMessage } from "../../types";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TimelineRowCtx } from "./timelineRowContext";

/**
 * Forks the thread through the run of `projectedItem`, a completed response. With `message`, the
 * user message after that run, the fork ends just before it and puts it back in the composer.
 */
export function TimelineForkButton({
  projectedItem,
  message,
}: {
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly message?: ChatMessage;
}) {
  const ctx = use(TimelineRowCtx);
  const gt = useGT();
  const [busy, setBusy] = useState(false);
  const support = useV2ItemSupport({
    environmentId: ctx.activeThreadEnvironmentId,
    sourceThreadId: projectedItem.sourceThreadId,
    sourceItemId: projectedItem.sourceItemId,
  });
  const canFork = canForkProjectedAssistantItem({
    projectedItem,
    capabilities: support.providerSession?.capabilities,
  });

  const onForkFromRun = ctx.onForkFromRun;
  const runId = projectedItem.item.runId;
  if (!canFork || onForkFromRun === undefined || runId === null) return null;
  const label = message ? gt("Fork from here") : gt("Fork from this response");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onForkFromRun({
                sourceThreadId: projectedItem.sourceThreadId,
                runId,
                ...(message ? { message } : {}),
              }).finally(() => setBusy(false));
            }}
            aria-label={label}
          />
        }
      >
        <GitForkIcon className={cn("size-3", busy && "animate-pulse")} />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
