import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** How the Claude desktop app relates one of its Claude Code sessions to another. */
export interface ClaudeDesktopLineage {
  /** The CLI session id of the session this one was spawned or forked from. */
  readonly parentSessionId: string;
  /** A "btw" side chat, which the desktop app keeps inside its parent. */
  readonly sideChat: boolean;
}

// The desktop app's own metadata files hold far more; only these fields matter here.
const DesktopSession = Schema.Struct({
  sessionId: Schema.String,
  cliSessionId: Schema.String,
  spawnedFrom: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        sessionId: Schema.optional(Schema.String),
        btw: Schema.optional(Schema.NullOr(Schema.Boolean)),
      }),
    ),
  ),
  forkedFromSessionId: Schema.optional(Schema.NullOr(Schema.String)),
  lineageDetached: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
const decodeDesktopSession = Schema.decodeUnknownOption(Schema.fromJsonString(DesktopSession));

/** Maps each session's CLI session id to its parent's, from the desktop app's metadata files. */
export function parseClaudeDesktopLineage(
  contents: ReadonlyArray<string>,
): ReadonlyMap<string, ClaudeDesktopLineage> {
  const sessions = contents.flatMap((text) => Option.toArray(decodeDesktopSession(text)));
  const cliSessionIdByDesktopId = new Map(
    sessions.map((session) => [session.sessionId, session.cliSessionId] as const),
  );
  const lineage = new Map<string, ClaudeDesktopLineage>();
  for (const session of sessions) {
    // The user detached it from its parent in the desktop app.
    if (session.lineageDetached === true) continue;
    const parentDesktopId = session.spawnedFrom?.sessionId ?? session.forkedFromSessionId;
    if (parentDesktopId == null) continue;
    const parentSessionId = cliSessionIdByDesktopId.get(parentDesktopId);
    if (parentSessionId === undefined || parentSessionId === session.cliSessionId) continue;
    lineage.set(session.cliSessionId, {
      parentSessionId,
      sideChat: session.spawnedFrom?.btw === true,
    });
  }
  return lineage;
}

// Larger files carry long cached prompts; their lineage is not worth the read.
const MAX_METADATA_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Reads `<home>/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/local_*.json`.
 * Only the macOS desktop app is known to write these; elsewhere the map is empty.
 */
export const readClaudeDesktopLineage = Effect.fn("ClaudeDesktopSessions.readLineage")(function* (
  homeDir: string,
  platform: string,
) {
  if (platform !== "darwin") return new Map<string, ClaudeDesktopLineage>();
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const list = (directory: string) =>
    fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const root = path.join(
    homeDir,
    "Library",
    "Application Support",
    "Claude",
    "claude-code-sessions",
  );
  const files: Array<string> = [];
  for (const account of yield* list(root)) {
    for (const org of yield* list(path.join(root, account))) {
      const directory = path.join(root, account, org);
      for (const name of yield* list(directory)) {
        if (name.startsWith("local_") && name.endsWith(".json")) {
          files.push(path.join(directory, name));
        }
      }
    }
  }
  const contents = yield* Effect.forEach(
    files,
    (file) =>
      fileSystem.stat(file).pipe(
        Effect.flatMap((stats) =>
          stats.type === "File" && Number(stats.size) <= MAX_METADATA_FILE_BYTES
            ? fileSystem.readFileString(file)
            : Effect.succeed(""),
        ),
        Effect.orElseSucceed(() => ""),
      ),
    { concurrency: 8 },
  );
  return parseClaudeDesktopLineage(contents);
});
