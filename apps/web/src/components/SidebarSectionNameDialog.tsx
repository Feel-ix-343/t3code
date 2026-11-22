import { useEffect, useId, useState } from "react";
import { T, useGT } from "gt-react";
import { create } from "zustand";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
} from "./ui/dialog";

type Request = {
  readonly initialTitle: string;
  readonly resolve: (title: string | null) => void;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/** Asks for a sidebar section's name; resolves null when dismissed. */
export function requestSidebarSectionName(initialTitle = ""): Promise<string | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { initialTitle, resolve } }));
}

function finish(title: string | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(title);
}

export function SidebarSectionNameDialogHost() {
  const request = useRequest((state) => state.request);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves any pending name request with null when the dialog host unmounts
  useEffect(() => () => finish(null), []);
  return request ? <SidebarSectionNameDialog initialTitle={request.initialTitle} /> : null;
}

function SidebarSectionNameDialog(props: { initialTitle: string }) {
  const gt = useGT();
  const id = useId();
  const [title, setTitle] = useState(props.initialTitle);
  const trimmed = title.trim();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed !== "") finish(trimmed);
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {props.initialTitle === "" ? <T>New section</T> : <T>Rename section</T>}
            </DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <Label className="flex flex-col items-stretch" htmlFor={`${id}-title`}>
              <T context="sidebar section name">Name</T>
              <Input
                nativeInput
                id={`${id}-title`}
                autoFocus
                maxLength={64}
                value={title}
                placeholder={gt("Section name")}
                onChange={(event) => setTitle(event.target.value.replace(/[\p{Cc}]/gu, ""))}
              />
            </Label>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => finish(null)}>
              <T>Cancel</T>
            </Button>
            <Button type="submit" disabled={trimmed === ""}>
              {props.initialTitle === "" ? <T>Create</T> : <T>Rename</T>}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
