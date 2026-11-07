/**
 * The scoped full-command read: the one place in the classifier that
 * touches payload evidence.
 *
 * A bash gate that intercepts one unit of a larger command attaches the whole
 * command as the payload's single "full command" evidence entry
 * (agent-authored ask text, never a tool result). This module extracts exactly
 * that entry — bash kind, designated label, non-empty string text — and
 * measures it for the budget gate and the audit trail. Everything else — other
 * kinds, other labels, malformed shapes — yields null, and nothing here
 * throws: absence degrades to the value-only prompt.
 */

import { createHash } from "node:crypto";

import type { PromptPayload } from "@gotgenes/pi-permission-system";

/** The upstream label on the enclosing-command evidence entry. */
const FULL_COMMAND_LABEL = "full command";

/**
 * The upstream label on a tool's input preview. For a configured command tool
 * (`commandTools`) the preview is the text the tool acts on, such as the shell
 * command it runs or the URL it opens, rendered by a registered tool-input
 * formatter, so it is read as the full command.
 */
const TOOL_INPUT_LABEL = "input";

/** The extracted full command with its measured facts. */
export interface FullCommandContext {
  /** The full command exactly as the payload carried it. */
  readonly text: string;
  /** UTF-8 byte length of the text, the budget-gate measure. */
  readonly bytes: number;
  /** First 12 lowercase hex chars of sha256(text), the audit correlator. */
  readonly hash12: string;
}

/** The evidence label that holds the command for this payload, or null when none does. */
function commandLabelOf(
  payload: PromptPayload,
  commandTools: readonly string[],
): string | null {
  if (payload.kind === "bash") return FULL_COMMAND_LABEL;
  const tool = payload.request?.toolName;
  return (payload.kind === "tool" || payload.kind === "mcp") &&
    typeof tool === "string" &&
    commandTools.includes(tool)
    ? TOOL_INPUT_LABEL
    : null;
}

/**
 * Extract the full-command context from a bash-kind ask payload, or null.
 *
 * A tool-kind or mcp-kind payload whose tool name is in `commandTools` counts
 * as well, and its "input" entry is the command. Null for any other payload kind, any
 * other label, a non-string or empty text, and an absent or malformed
 * evidence array. Never throws.
 */
export function extractFullCommandContext(
  payload: PromptPayload,
  commandTools: readonly string[] = [],
): FullCommandContext | null {
  try {
    if (typeof payload !== "object" || payload === null) return null;
    const label = commandLabelOf(payload, commandTools);
    if (label === null) return null;

    const { evidence } = payload;
    if (!Array.isArray(evidence)) return null;

    const entry = evidence.find(
      (candidate): boolean =>
        typeof candidate === "object" &&
        candidate !== null &&
        candidate.label === label,
    );
    if (entry === undefined) return null;

    const { text } = entry;
    if (typeof text !== "string" || text === "") return null;

    return {
      text,
      bytes: Buffer.byteLength(text, "utf8"),
      hash12: createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12),
    };
  } catch {
    return null;
  }
}
