import {
  IsoDateTime,
  ModelSelection,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** Above this, a gzipped Claude transcript stays here and the thread moves with its history only. */
export const MAX_MOVED_TRANSCRIPT_BYTES = 24 * 1024 * 1024;

export const MovedHistoryMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  createdAt: IsoDateTime,
});
export type MovedHistoryMessage = typeof MovedHistoryMessage.Type;

/** What a linked environment sends to `t3_thread_receive` when it moves a thread here. */
export const ThreadReceiveInput = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  /** A branch on the repository's shared remote that holds `commit`. */
  branch: TrimmedNonEmptyString,
  commit: TrimmedNonEmptyString,
  history: Schema.Array(MovedHistoryMessage),
  /** The Claude Code session to resume here, its transcript gzipped and base64-encoded. */
  claudeSession: Schema.optional(
    Schema.Struct({
      sessionId: TrimmedNonEmptyString,
      /** The checkout it ran in there, so the transcript's paths can point here instead. */
      cwd: TrimmedNonEmptyString,
      transcript: Schema.String,
    }),
  ),
  message: Schema.optional(Schema.String.check(Schema.isMaxLength(120000))),
});
export type ThreadReceiveInput = typeof ThreadReceiveInput.Type;

export const ThreadReceiveResult = Schema.Struct({
  threadId: ThreadId,
  link: Schema.optional(Schema.String),
  branch: Schema.String,
  worktreePath: Schema.String,
  context: Schema.Literals(["resumed", "history"]),
  runId: Schema.NullOr(RunId),
});
export type ThreadReceiveResult = typeof ThreadReceiveResult.Type;

/** The folder under `<claude config>/projects` where Claude Code keeps a cwd's sessions. */
export const claudeProjectDirectoryName = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

const isUnder = (candidate: string, root: string) =>
  candidate === root || candidate.startsWith(root.endsWith("/") ? root : `${root}/`);

/**
 * A Claude Code transcript with every `cwd` under `from` moved under `to`; other cwds become `to`.
 * A last line without its newline may still be being written, so it is dropped.
 */
export function rehomeClaudeTranscript(text: string, from: string, to: string): string {
  const lines = text.split("\n");
  // Everything after the last newline is a line still being written, or nothing.
  lines.pop();
  return lines
    .filter((line) => line.trim() !== "")
    .map((line) => {
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        return line;
      }
      if (typeof record !== "object" || record === null || !("cwd" in record)) return line;
      const cwd = record.cwd;
      if (typeof cwd !== "string") return line;
      const moved = isUnder(cwd, from) ? `${to}${cwd.slice(from.replace(/\/$/, "").length)}` : to;
      return JSON.stringify({ ...record, cwd: moved });
    })
    .map((line) => `${line}\n`)
    .join("");
}

/**
 * The branch a moved thread's work is pushed to: its own, unless it has none or works on the
 * default branch, which a move must not publish work-in-progress to.
 */
export function movedBranchName(input: {
  readonly branch: string | null;
  readonly defaultBranch: string | null;
  readonly threadId: string;
}): string {
  if (input.branch !== null && input.branch !== "HEAD" && input.branch !== input.defaultBranch) {
    return input.branch;
  }
  const suffix = input.threadId.replace(/[^a-zA-Z0-9]/g, "").slice(-8) || "thread";
  return `t3/moved-${suffix}`;
}

/** A thread's finished user and agent messages, in order, as history to send. */
export function movedHistory(
  messages: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "role" | "text" | "streaming" | "createdAt">
  >,
  formatIso: (at: OrchestrationV2ConversationMessage["createdAt"]) => string,
): ReadonlyArray<MovedHistoryMessage> {
  return messages.flatMap((message) =>
    (message.role === "user" || message.role === "assistant") &&
    !message.streaming &&
    message.text.trim() !== ""
      ? [{ role: message.role, text: message.text, createdAt: formatIso(message.createdAt) }]
      : [],
  );
}

/** What the agent there is told when a turn was still running here. */
export function continueMessage(input: { readonly wipCommit: string | null }): string {
  const wip =
    input.wipCommit === null
      ? ""
      : ` Changes that were not committed there are in commit ${input.wipCommit.slice(0, 12)} (a WIP commit on top of the branch); amend or squash it as fits.`;
  return `This thread was moved here from another machine while you were working. The checkout matches the one there.${wip} Continue where you left off.`;
}
