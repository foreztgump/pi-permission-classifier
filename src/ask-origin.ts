/**
 * Where an ask comes from: the requesting agent's working directory and, for a
 * subagent, the brief its parent agent gave it. Both reach the LLM judge's
 * prompt (src/prompt.ts); the brief is labelled there as the parent agent's
 * text, never the user's.
 *
 * A forwarded ask is judged in the serving process, and the permission system
 * does not hand the child's cwd or brief across (the forwarded request holds
 * the cwd, but the ask details drop it). So the serving process finds the
 * requester in its own session: pstack's agent launcher records every
 * subagent it starts as a `pstack-agents` custom entry (the child's session
 * id, its cwd, and its brief). The ask names the requesting session, and that
 * entry is the match. No match means no brief, and the cwd falls back to this
 * session's, marked so the judge cannot mistake it for the requester's.
 *
 * The pi-subagents package writes no such entry. For an ask from one of its
 * children the parent session holds only the launch: a `subagent` tool result
 * whose details name the run's directory. That directory's status.json lists
 * each step's child session file, and the file's header holds the child's
 * session id and cwd; its first user message is the brief (`Task: <brief>`).
 * The child session id is not in the parent session, so the match reads the
 * candidate runs' files and compares the header id with the requester's. A
 * file that is missing or malformed is no match, and the fallback above holds.
 *
 * Nested agents need nothing extra: each process reads its own session, so a
 * child that serves its own child's ask finds that grandchild, and the root
 * finds the child it started when the ask arrives from there.
 */

import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { clip, firstUserText, isSubagentProcess } from "./user-intent";

/** The custom entry type pstack's agent launcher writes for each subagent. */
const PSTACK_AGENTS_ENTRY = "pstack-agents";

/** The tool name pi-subagents gives its launcher. */
const SUBAGENT_TOOL = "subagent";

/** Launch results scanned per ask, newest first. */
const MAX_RUNS_SCANNED = 32;

/** Steps read per run (a chain or parallel run lists one per step). */
const MAX_STEPS_PER_RUN = 32;

/** Bytes read first from every candidate child session file: enough for its header line. */
const HEADER_PROBE_BYTES = 8 * 1024;

/** Bytes read from the head of the matching child session file: its header and first user message. */
const SESSION_HEAD_BYTES = 256 * 1024;

/** The prefix pi-subagents puts on the brief in the child's first user message. */
const TASK_PREFIX_RE = /^Task: /;

/** Where one ask came from, as the prompt renders it. */
export interface AskOrigin {
  readonly cwd: string;
  /** `requester`: the asking agent's own cwd. `session`: this process's; the requester's is not known. */
  readonly cwdOf: "requester" | "session";
  /** The parent agent's brief for the requesting subagent, already capped. Absent when none is known. */
  readonly brief?: string;
}

/** The requester facts the ask details carry. */
export interface AskRequester {
  readonly forwarded: boolean;
  readonly sessionId: string | null;
}

/** The slice of the session context the origin read needs. */
export interface AskOriginSource {
  readonly cwd: string;
  readonly sessionManager: { getBranch(): SessionEntry[] };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The newest `pstack-agents` record for a child session id, read defensively. */
function recordFor(
  entries: readonly SessionEntry[],
  sessionId: string,
): { cwd?: string; brief?: string } | undefined {
  let found: { cwd?: string; brief?: string } | undefined;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== PSTACK_AGENTS_ENTRY) continue;
    const agent = (entry.data as { agent?: Record<string, unknown> } | undefined)?.agent;
    if (agent === null || typeof agent !== "object" || agent.sessionId !== sessionId) continue;
    const cwd = nonEmptyString(agent.cwd);
    const brief = nonEmptyString(agent.brief);
    found = { ...(cwd === undefined ? {} : { cwd }), ...(brief === undefined ? {} : { brief }) };
  }
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** The first bytes of a file as text; undefined when it cannot be read. */
function readHead(path: string, maxBytes: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(maxBytes);
    const read = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.toString("utf-8", 0, read);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A session entry whose message can be read as user text: a role, and string or array content. */
function isReadableMessage(entry: unknown): entry is SessionEntry {
  if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) return false;
  const { role, content } = entry.message;
  return typeof role === "string" && (typeof content === "string" || (Array.isArray(content) && content.every(isRecord)));
}

/**
 * The cwd and brief of a pi-subagents child session file when its header id
 * is `sessionId`, else undefined. A small head is read first and compared;
 * only the matching file is read further. A line cut by a limit does not
 * parse and is skipped (a header cut by the first limit is no match). The file is written by a
 * child process: its cwd and text are context for the judge, never a path to
 * act on.
 */
function childSession(
  file: string,
  sessionId: string,
): { cwd?: string; brief?: string } | undefined {
  const probe = readHead(file, HEADER_PROBE_BYTES);
  if (probe === undefined) return undefined;
  const header = parseJson(probe.split("\n", 1)[0] ?? "");
  if (!isRecord(header) || header.type !== "session" || header.id !== sessionId) return undefined;
  const head = readHead(file, SESSION_HEAD_BYTES);
  if (head === undefined) return undefined;
  const messages = head.split("\n").slice(1).map(parseJson).filter(isReadableMessage);
  const text = firstUserText(messages);
  const cwd = nonEmptyString(header.cwd);
  const brief = text === null ? undefined : nonEmptyString(text.replace(TASK_PREFIX_RE, ""));
  return { ...(cwd === undefined ? {} : { cwd }), ...(brief === undefined ? {} : { brief }) };
}

/** The child session files listed by one run's status.json, or none. */
function runSessionFiles(asyncDir: string): string[] {
  let status: unknown;
  try {
    status = parseJson(readFileSync(join(asyncDir, "status.json"), "utf-8"));
  } catch {
    return [];
  }
  const steps = isRecord(status) && Array.isArray(status.steps) ? status.steps : [];
  return steps
    .slice(0, MAX_STEPS_PER_RUN)
    .map((step) => (isRecord(step) ? step.sessionFile : undefined))
    .filter((file): file is string => typeof file === "string" && file.endsWith(".jsonl"));
}

/**
 * The pi-subagents child with this session id, found through the `subagent`
 * launch results in the branch (newest first, at most MAX_RUNS_SCANNED); the
 * first run whose session file carries the id wins.
 */
function subagentChildFor(
  entries: readonly SessionEntry[],
  sessionId: string,
): { cwd?: string; brief?: string } | undefined {
  let scanned = 0;
  for (let i = entries.length - 1; i >= 0 && scanned < MAX_RUNS_SCANNED; i--) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const message: unknown = entry.message;
    if (!isRecord(message) || message.role !== "toolResult" || message.toolName !== SUBAGENT_TOOL) {
      continue;
    }
    const asyncDir = isRecord(message.details)
      ? nonEmptyString(message.details.asyncDir)
      : undefined;
    if (asyncDir === undefined) continue;
    scanned += 1;
    for (const file of runSessionFiles(asyncDir)) {
      const found = childSession(file, sessionId);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * The origin of one ask, or undefined when it cannot be read (no session, or
 * any throw), so the prompt renders as it did before.
 *
 * A forwarded ask looks its requester up in this session. A local ask is the
 * session's own: its cwd is the session's, and in a subagent process the
 * session's first user message is the brief its parent wrote.
 */
export function readAskOrigin(
  source: AskOriginSource | undefined,
  requester: AskRequester,
  env: NodeJS.ProcessEnv = process.env,
): AskOrigin | undefined {
  if (source === undefined) return undefined;
  try {
    const cwd = nonEmptyString(source.cwd);
    if (cwd === undefined) return undefined;
    const entries = source.sessionManager.getBranch();
    if (requester.forwarded) {
      const record =
        requester.sessionId === null
          ? undefined
          : (recordFor(entries, requester.sessionId) ??
            subagentChildFor(entries, requester.sessionId));
      const brief = record?.brief === undefined ? undefined : clip(record.brief).text;
      return {
        cwd: record?.cwd ?? cwd,
        cwdOf: record?.cwd === undefined ? "session" : "requester",
        ...(brief === undefined ? {} : { brief }),
      };
    }
    const own = isSubagentProcess(env) ? firstUserText(entries) : null;
    return {
      cwd,
      cwdOf: "requester",
      ...(own === null ? {} : { brief: clip(own).text }),
    };
  } catch {
    return undefined;
  }
}
