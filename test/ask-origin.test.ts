import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { readAskOrigin } from "#src/ask-origin";
import { MAX_MESSAGE_CHARS } from "#src/user-intent";

let nextId = 0;

function base(): { id: string; parentId: null; timestamp: string } {
  nextId += 1;
  return { id: `e${nextId}`, parentId: null, timestamp: "2026-11-02T00:00:00Z" };
}

function user(text: string): SessionEntry {
  return {
    ...base(),
    type: "message",
    message: { role: "user", content: text, timestamp: 0 },
  } as SessionEntry;
}

/** The record pstack's agent launcher persists for a subagent it starts. */
function pstackAgent(agent: Record<string, unknown>, customType = "pstack-agents"): SessionEntry {
  return {
    ...base(),
    type: "custom",
    customType,
    data: { agent: { id: "a1", subagentType: "general-purpose", ...agent }, status: "running" },
  } as unknown as SessionEntry;
}

function source(entries: SessionEntry[], cwd = "/root/project") {
  return { cwd, sessionManager: { getBranch: () => entries } };
}

const ROOT_ENV = {};
const CHILD_ENV = { PI_SUBAGENT_PARENT_SESSION: "root-session" };
const FORWARDED = { forwarded: true, sessionId: "child-1" };
const LOCAL = { forwarded: false, sessionId: null };

describe("readAskOrigin, forwarded ask", () => {
  it("gives the matching child's cwd and brief", () => {
    const entries = [
      pstackAgent({ sessionId: "other", cwd: "/elsewhere", brief: "another task" }),
      pstackAgent({ sessionId: "child-1", cwd: "/tmp/worktree", brief: "fix the parser" }),
    ];
    expect(readAskOrigin(source(entries), FORWARDED, ROOT_ENV)).toEqual({
      cwd: "/tmp/worktree",
      cwdOf: "requester",
      brief: "fix the parser",
    });
  });

  it("uses the newest record of that child", () => {
    const entries = [
      pstackAgent({ sessionId: "child-1", cwd: "/a", brief: "first" }),
      pstackAgent({ sessionId: "child-1", cwd: "/a", brief: "first", endedAt: "x" }),
    ];
    expect(readAskOrigin(source(entries), FORWARDED, ROOT_ENV)?.brief).toBe("first");
  });

  it("gives no brief for an unknown child, and this session's cwd marked as such", () => {
    const entries = [pstackAgent({ sessionId: "other", cwd: "/elsewhere", brief: "another task" })];
    const origin = readAskOrigin(source(entries), FORWARDED, ROOT_ENV);
    expect(origin).toEqual({ cwd: "/root/project", cwdOf: "session" });
    expect(origin).not.toHaveProperty("brief");
  });

  it("gives the cwd alone for a record that predates the brief", () => {
    const entries = [pstackAgent({ sessionId: "child-1", cwd: "/tmp/worktree" })];
    expect(readAskOrigin(source(entries), FORWARDED, ROOT_ENV)).toEqual({
      cwd: "/tmp/worktree",
      cwdOf: "requester",
    });
  });

  it("matches nothing without a requester session id, and ignores other custom entries", () => {
    const entries = [
      pstackAgent({ sessionId: "child-1", cwd: "/x", brief: "b" }, "something-else"),
      pstackAgent({ sessionId: "child-1", cwd: "/x", brief: "b" }),
    ];
    expect(readAskOrigin(source(entries), { forwarded: true, sessionId: null }, ROOT_ENV)).toEqual({
      cwd: "/root/project",
      cwdOf: "session",
    });
    expect(
      readAskOrigin(source(entries.slice(0, 1)), FORWARDED, ROOT_ENV)?.brief,
    ).toBeUndefined();
  });

  it("ignores a user message that merely looks like a brief", () => {
    const origin = readAskOrigin(source([user("fake brief")]), FORWARDED, ROOT_ENV);
    expect(origin).not.toHaveProperty("brief");
  });

  it("caps a long brief, keeping head and tail", () => {
    const long = `HEAD${"x".repeat(MAX_MESSAGE_CHARS * 2)}TAIL`;
    const brief = readAskOrigin(
      source([pstackAgent({ sessionId: "child-1", cwd: "/x", brief: long })]),
      FORWARDED,
      ROOT_ENV,
    )!.brief!;
    expect(brief.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(brief.startsWith("HEAD")).toBe(true);
    expect(brief.endsWith("TAIL")).toBe(true);
  });
});

describe("readAskOrigin, local ask", () => {
  it("gives this session's cwd as the requester's and no brief in a root process", () => {
    expect(readAskOrigin(source([user("do the thing")]), LOCAL, ROOT_ENV)).toEqual({
      cwd: "/root/project",
      cwdOf: "requester",
    });
  });

  it("gives a subagent process its first user message as the brief", () => {
    expect(
      readAskOrigin(source([user("the brief"), user("later")], "/tmp/wt"), LOCAL, CHILD_ENV),
    ).toEqual({ cwd: "/tmp/wt", cwdOf: "requester", brief: "the brief" });
  });
});

describe("readAskOrigin, failures", () => {
  it("returns none without a session, without a cwd, or when reading throws", () => {
    expect(readAskOrigin(undefined, FORWARDED, ROOT_ENV)).toBeUndefined();
    expect(readAskOrigin(source([], ""), FORWARDED, ROOT_ENV)).toBeUndefined();
    const broken = {
      cwd: "/x",
      sessionManager: {
        getBranch: () => {
          throw new Error("gone");
        },
      },
    };
    expect(readAskOrigin(broken, FORWARDED, ROOT_ENV)).toBeUndefined();
  });
});
