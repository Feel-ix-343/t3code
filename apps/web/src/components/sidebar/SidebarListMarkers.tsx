import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ContextMenuSource } from "@t3tools/contracts";
import { BookmarkIcon, EllipsisIcon } from "lucide-react";
import { type ReactNode, useLayoutEffect } from "react";
import { contextMenuSourceOf } from "../../contextMenuSource";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";
import {
  animateSidebarLayoutChanges,
  sidebarMarkerId,
  type SidebarListMarker,
} from "../Sidebar.logic";
import { SIDEBAR_SORTABLE_DRAG_DISABLED } from "./SidebarThreadRow";

function SortableSidebarMarker(props: {
  marker: SidebarListMarker;
  className?: string;
  children?: ReactNode;
  revealOverflow?: boolean;
  "data-testid"?: string;
}) {
  return (
    <SidebarSortableSlot
      {...props}
      id={sidebarMarkerId(props.marker)}
      placeholder={props.marker.endsWith("-placeholder")}
    />
  );
}

/** A list row the dragged thread sorts around; it never drags itself. */
export function SidebarSortableSlot(props: {
  id: string;
  placeholder?: boolean;
  className?: string;
  children?: ReactNode;
  revealOverflow?: boolean;
  "data-testid"?: string;
}) {
  const { node, setNodeRef, transform, transition } = useSortable({
    id: props.id,
    disabled: SIDEBAR_SORTABLE_DRAG_DISABLED,
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the projected drop box inside the scroll viewport as drag transforms move it
  useLayoutEffect(() => {
    if (props.revealOverflow && transform?.y !== undefined) {
      node.current?.firstElementChild?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [node, props.revealOverflow, transform?.y]);
  return (
    <li
      ref={setNodeRef}
      data-thread-selection-safe
      data-testid={props["data-testid"]}
      className={cn("list-none", props.className)}
      style={{
        transform: CSS.Translate.toString(transform),
        transition: props.placeholder ? "none" : transition,
        visibility: transform?.scaleY === 0 ? "hidden" : undefined,
      }}
    >
      {props.children}
    </li>
  );
}

export function SidebarSectionPlaceholder(props: {
  marker: "active-placeholder" | "settled-placeholder";
  label: string;
  showHint: boolean;
  isDropTarget: boolean;
}) {
  return (
    <SortableSidebarMarker
      marker={props.marker}
      data-testid={`sidebar-${props.marker}`}
      className="relative mx-0.5 -mb-px h-0"
      // Revealing on every drag scrolls the list out from under the pointer.
      revealOverflow={
        props.marker === "settled-placeholder" && props.showHint && props.isDropTarget
      }
    >
      {props.showHint ? (
        <div
          className={cn(
            "absolute inset-x-0 top-0 flex h-9 items-center justify-center rounded-md border border-dashed border-sidebar-foreground/25 text-xs text-sidebar-foreground/80",
            props.isDropTarget && "border-primary/40 bg-primary/5 text-primary",
          )}
        >
          {props.label}
        </div>
      ) : null}
    </SortableSidebarMarker>
  );
}

export function SidebarDragBoundary(props: {
  marker: "pinned-header" | "pinned-divider";
  label: string;
  visible: boolean;
  isDropTarget: boolean;
}) {
  return (
    <SortableSidebarMarker
      marker={props.marker}
      data-testid={`sidebar-${props.marker}`}
      className="pointer-events-none relative mx-0.5 -mb-px h-0"
    >
      {props.visible ? (
        <div className="sidebar-drag-boundary-label absolute inset-x-2 top-1 flex h-4 items-center gap-2">
          <span
            className={cn(
              "shrink-0 text-xs font-medium",
              props.isDropTarget ? "text-primary" : "text-sidebar-foreground/80",
            )}
          >
            {props.label}
          </span>
          <span
            aria-hidden
            className={cn(
              "h-px flex-1",
              props.isDropTarget ? "bg-primary/50" : "bg-sidebar-foreground/25",
            )}
          />
        </div>
      ) : null}
    </SortableSidebarMarker>
  );
}

export function SidebarSectionHeader(props: {
  marker: "working-header" | "snoozed-header" | "settled-header";
  label: string;
  /** A muted trailing count. */
  count: number;
  className?: string;
  dragging?: boolean;
  isDropTarget?: boolean;
  toggle: { expanded: boolean; onToggle: () => void };
}) {
  const shelf =
    props.marker === "working-header"
      ? "working"
      : props.marker === "snoozed-header"
        ? "snoozed"
        : "settled";
  return (
    <SortableSidebarMarker
      marker={props.marker}
      data-testid={`sidebar-${props.marker}`}
      className={cn("relative mx-0.5 h-8", props.className)}
    >
      <CollapsibleSectionHeader
        data-sidebar-row={`shelf:${shelf}`}
        onClick={props.toggle.onToggle}
        expanded={props.toggle.expanded}
        tone={props.isDropTarget ? "accent" : props.dragging ? "emphasized" : "muted"}
        data-testid={`sidebar-${shelf}-shelf-toggle`}
        accessory={<span className="font-normal tabular-nums">{props.count}</span>}
      >
        {props.label}
      </CollapsibleSectionHeader>
    </SortableSidebarMarker>
  );
}

export function SidebarCustomSectionHeader(props: {
  id: string;
  title: string;
  count: number;
  isDropTarget: boolean;
  menuLabel: string;
  onMenu: (position: { x: number; y: number }, source: ContextMenuSource) => void;
}) {
  return (
    <SidebarSortableSlot
      id={props.id}
      data-testid="sidebar-custom-section"
      className="group/custom-section relative mx-0.5 mt-2 h-8"
    >
      <div
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left",
          props.isDropTarget ? "text-primary" : "text-sidebar-foreground/90",
        )}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onMenu({ x: event.clientX, y: event.clientY }, contextMenuSourceOf(event));
        }}
      >
        <BookmarkIcon aria-hidden className="size-3.5 shrink-0 text-sidebar-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{props.title}</span>
        <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground group-hover/custom-section:hidden pointer-coarse:hidden">
          {props.count}
        </span>
        <span className="hidden group-hover/custom-section:flex pointer-coarse:flex">
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={props.menuLabel}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              props.onMenu({ x: rect.left, y: rect.bottom }, contextMenuSourceOf(event));
            }}
          >
            <EllipsisIcon aria-hidden />
          </Button>
        </span>
      </div>
    </SidebarSortableSlot>
  );
}

export function SidebarCustomSectionPlaceholder(props: {
  id: string;
  label: string;
  isDropTarget: boolean;
}) {
  return (
    <SidebarSortableSlot id={props.id} placeholder className="mx-0.5 h-9">
      <div
        className={cn(
          "flex h-9 items-center justify-center rounded-md border border-dashed border-sidebar-foreground/20 text-xs text-sidebar-muted-foreground",
          props.isDropTarget && "border-primary/40 bg-primary/5 text-primary",
        )}
      >
        {props.label}
      </div>
    </SidebarSortableSlot>
  );
}
