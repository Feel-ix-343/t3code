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
  isStarred: Schema.optional(Schema.NullOr(Schema.Boolean)),
  isArchived: Schema.optional(Schema.NullOr(Schema.Boolean)),
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

/** How the Claude desktop app organizes its Claude Code sessions in its sidebar. */
export interface ClaudeDesktopOrganization {
  /** The sections the user named, in sidebar order. */
  readonly sections: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** Each assigned session's section id, by CLI session id. */
  readonly sectionBySession: ReadonlyMap<string, string>;
  /** CLI session ids of starred (pinned) sessions, in the desktop app's pinned order. */
  readonly starred: ReadonlyArray<string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const records = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter(isRecord) : [];
const strings = (value: unknown): Array<string> =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
const DESKTOP_CODE_SESSION_PREFIX = "code:";

/**
 * Reads `preferences.epitaxyPrefs` of `claude_desktop_config.json`: sections
 * (`dframe-code-sections`), assignments (`dframe-group-scopes`), and stars in pinned order.
 * Metadata files map desktop session ids to CLI ones; archived sessions are left out.
 */
export function parseClaudeDesktopOrganization(
  config: string,
  metadataContents: ReadonlyArray<string>,
): ClaudeDesktopOrganization {
  const sessions = metadataContents.flatMap((text) => Option.toArray(decodeDesktopSession(text)));
  const live = new Map(
    sessions
      .filter((session) => session.isArchived !== true)
      .map((session) => [session.sessionId, session] as const),
  );
  let prefs: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(config);
    const preferences = isRecord(parsed) ? parsed["preferences"] : undefined;
    const epitaxy = isRecord(preferences) ? preferences["epitaxyPrefs"] : undefined;
    if (isRecord(epitaxy)) prefs = epitaxy;
  } catch {
    // An unreadable config organizes nothing.
  }
  const scopes = (key: string) => {
    const value = prefs[key];
    return isRecord(value) ? Object.values(value).filter(isRecord) : [];
  };

  const sections: Array<{ id: string; name: string }> = [];
  const seenSections = new Set<string>();
  const addSection = (id: unknown, name: unknown) => {
    if (typeof id !== "string" || typeof name !== "string" || name.trim() === "") return;
    if (seenSections.has(id)) return;
    seenSections.add(id);
    sections.push({ id, name: name.trim() });
  };
  for (const scope of scopes("dframe-code-sections")) {
    const manual = records(scope["sections"])
      .filter((section) => section["kind"] === "manual")
      .toSorted((left, right) => Number(left["order"] ?? 0) - Number(right["order"] ?? 0));
    for (const section of manual) addSection(section["id"], section["name"]);
  }
  const sectionBySession = new Map<string, string>();
  for (const scope of scopes("dframe-group-scopes")) {
    // Groups the sections list does not name yet still have their own names.
    for (const group of records(scope["groups"])) addSection(group["id"], group["name"]);
    const assignments = scope["assignments"];
    if (!isRecord(assignments)) continue;
    for (const [key, sectionId] of Object.entries(assignments)) {
      if (!key.startsWith(DESKTOP_CODE_SESSION_PREFIX) || typeof sectionId !== "string") continue;
      const session = live.get(key.slice(DESKTOP_CODE_SESSION_PREFIX.length));
      if (session === undefined || !seenSections.has(sectionId)) continue;
      sectionBySession.set(session.cliSessionId, sectionId);
    }
  }

  const starredIds = new Set([
    ...strings(prefs["starred-local-code-sessions"]),
    ...sessions.flatMap((session) => (session.isStarred === true ? [session.sessionId] : [])),
  ]);
  const slice = prefs["dframe-local-slice"];
  const pinnedOrder = strings(isRecord(slice) ? slice["pinnedOrder"] : undefined).map((key) =>
    key.startsWith(DESKTOP_CODE_SESSION_PREFIX)
      ? key.slice(DESKTOP_CODE_SESSION_PREFIX.length)
      : key,
  );
  const starred: Array<string> = [];
  for (const desktopId of [...pinnedOrder, ...starredIds]) {
    const session = live.get(desktopId);
    if (!starredIds.has(desktopId) || session === undefined) continue;
    if (!starred.includes(session.cliSessionId)) starred.push(session.cliSessionId);
  }
  return { sections, sectionBySession, starred };
}

// Larger files carry long cached prompts; their lineage is not worth the read.
const MAX_METADATA_FILE_BYTES = 4 * 1024 * 1024;

const claudeDesktopRoot = (path: Path.Path, homeDir: string) =>
  path.join(homeDir, "Library", "Application Support", "Claude");

/** The contents of `<home>/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/local_*.json`. */
const readDesktopSessionFiles = Effect.fn("ClaudeDesktopSessions.readSessionFiles")(function* (
  homeDir: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const list = (directory: string) =>
    fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const root = path.join(claudeDesktopRoot(path, homeDir), "claude-code-sessions");
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
  return yield* Effect.forEach(
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
});

/**
 * Reads the lineage the desktop app records in its session metadata files.
 * Only the macOS desktop app is known to write these; elsewhere the map is empty.
 */
export const readClaudeDesktopLineage = Effect.fn("ClaudeDesktopSessions.readLineage")(function* (
  homeDir: string,
  platform: string,
) {
  if (platform !== "darwin") return new Map<string, ClaudeDesktopLineage>();
  return parseClaudeDesktopLineage(yield* readDesktopSessionFiles(homeDir));
});

/** Reads the desktop app's sidebar organization (macOS); elsewhere it is empty. */
export const readClaudeDesktopOrganization = Effect.fn("ClaudeDesktopSessions.readOrganization")(
  function* (homeDir: string, platform: string) {
    const empty: ClaudeDesktopOrganization = {
      sections: [],
      sectionBySession: new Map(),
      starred: [],
    };
    if (platform !== "darwin") return empty;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* fileSystem
      .readFileString(path.join(claudeDesktopRoot(path, homeDir), "claude_desktop_config.json"))
      .pipe(Effect.orElseSucceed(() => ""));
    if (config === "") return empty;
    return parseClaudeDesktopOrganization(config, yield* readDesktopSessionFiles(homeDir));
  },
);
