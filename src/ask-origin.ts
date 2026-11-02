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
 * Nested agents need nothing extra: each process reads its own session, so a
 * child that serves its own child's ask finds that grandchild, and the root
 * finds the child it started when the ask arrives from there.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { clip, firstUserText, isSubagentProcess } from "./user-intent";

/** The custom entry type pstack's agent launcher writes for each subagent. */
const PSTACK_AGENTS_ENTRY = "pstack-agents";

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
        requester.sessionId === null ? undefined : recordFor(entries, requester.sessionId);
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
