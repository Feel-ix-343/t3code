import { useGT } from "gt-react";
import { memo } from "react";

import { formatContextWindowTokens } from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const RADIUS = 5.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** A small ring under the composer showing how full the thread's context window is. */
export const ComposerContextRing = memo(function ComposerContextRing(props: {
  usedTokens: number;
  maxTokens: number;
}) {
  const gt = useGT();
  if (!(props.maxTokens > 0)) return null;
  const fraction = Math.min(1, Math.max(0, props.usedTokens / props.maxTokens));
  const percent = Math.round(fraction * 100);
  const label = gt("Context: {used} of {max} tokens ({percent}%)", {
    used: formatContextWindowTokens(props.usedTokens),
    max: formatContextWindowTokens(props.maxTokens),
    percent,
  });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            data-composer-context-ring
            className="inline-flex size-7 shrink-0 items-center justify-center"
          />
        }
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" className="-rotate-90">
          <circle
            cx="7"
            cy="7"
            r={RADIUS}
            fill="none"
            strokeWidth="1.5"
            className="stroke-foreground/15"
          />
          <circle
            cx="7"
            cy="7"
            r={RADIUS}
            fill="none"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
            className={cn(
              fraction >= 0.9
                ? "stroke-destructive"
                : fraction >= 0.7
                  ? "stroke-warning"
                  : "stroke-muted-foreground",
            )}
          />
        </svg>
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
});
