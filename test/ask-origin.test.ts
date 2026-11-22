import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it, vi } from "vitest";

import { readAskOrigin } from "#src/ask-origin";
import { MAX_MESSAGE_CHARS } from "#src/user-intent";

/** Every length a `readSync` call asked for, so a test can bound how much a file is read. */
const readLengths = vi.hoisted((): number[] => []);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readSync: ((
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number,
    ) => {
      readLengths.push(length);
      return actual.readSync(fd, buffer, offset, length, position);
    }) as typeof actual.readSync,
  };
});

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
    expect(readAskOrigin(source(entries.slice(0, 1)), FORWARDED, ROOT_ENV)?.brief).toBeUndefined();
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

const scratch = mkdtempSync(join(tmpdir(), "ask-origin-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let nextRun = 0;

interface ChildFile {
  /** Session header id; the file is skipped when undefined. */
  id?: string;
  cwd?: string;
  /** Lines written after the header. */
  rest?: string[];
}

/** The first user message pi-subagents writes into a child session. */
function taskLine(brief: string): string {
  return JSON.stringify({
    type: "message",
    id: "m1",
    parentId: null,
    timestamp: "2026-11-03T00:00:00Z",
    message: { role: "user", content: [{ type: "text", text: `Task: ${brief}` }], timestamp: 0 },
  });
}

/**
 * A pi-subagents run on disk: status.json listing one child session file per
 * `children` item. Returns the `subagent` launch result the parent session
 * holds for it.
 */
function subagentRun(children: ChildFile[], options: { statusJson?: string } = {}): SessionEntry {
  nextRun += 1;
  const asyncDir = join(scratch, `run-${nextRun}`);
  mkdirSync(asyncDir, { recursive: true });
  const steps = children.map((child, index) => {
    const sessionFile = join(asyncDir, `step-${index}.jsonl`);
    const header = JSON.stringify({
      type: "session",
      version: 3,
      id: child.id,
      cwd: child.cwd,
      parentSession: "/parent/session.jsonl",
    });
    writeFileSync(sessionFile, [header, ...(child.rest ?? [])].join("\n") + "\n");
    return { agent: "worker", status: "running", sessionFile };
  });
  writeFileSync(join(asyncDir, "status.json"), options.statusJson ?? JSON.stringify({ steps }));
  return launchResult(asyncDir);
}

function launchResult(asyncDir: string | undefined, toolName = "subagent"): SessionEntry {
  return {
    ...base(),
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "call_1",
      toolName,
      content: [{ type: "text", text: "Async: worker" }],
      details: { mode: "single", runId: "r", ...(asyncDir === undefined ? {} : { asyncDir }) },
      isError: false,
      timestamp: 0,
    },
  } as unknown as SessionEntry;
}

const FALLBACK = { cwd: "/root/project", cwdOf: "session" };

describe("readAskOrigin, forwarded ask from a pi-subagents child", () => {
  it("gives the child's cwd and its brief without the Task prefix", () => {
    const entries = [
      user("start"),
      subagentRun([{ id: "child-1", cwd: "/tmp/wt", rest: [taskLine("fix the parser")] }]),
    ];
    expect(readAskOrigin(source(entries), FORWARDED, ROOT_ENV)).toEqual({
      cwd: "/tmp/wt",
      cwdOf: "requester",
      brief: "fix the parser",
    });
  });

  it("picks the run and step whose session id matches", () => {
    const entries = [
      subagentRun([{ id: "child-1", cwd: "/a", rest: [taskLine("older run")] }]),
      subagentRun([
        { id: "other", cwd: "/b", rest: [taskLine("not me")] },
        { id: "child-1b", cwd: "/c", rest: [taskLine("sibling")] },
      ]),
      subagentRun([{ id: "another", cwd: "/d", rest: [taskLine("newest, not me")] }]),
    ];
    expect(readAskOrigin(source(entries), FORWARDED, ROOT_ENV)).toEqual({
      cwd: "/a",
      cwdOf: "requester",
      brief: "older run",
    });
    const chain = [
      subagentRun([
        { id: "x", cwd: "/x", rest: [taskLine("step one")] },
        { id: "child-1", cwd: "/y", rest: [taskLine("step two")] },
      ]),
    ];
    expect(readAskOrigin(source(chain), FORWARDED, ROOT_ENV)).toMatchObject({
      cwd: "/y",
      brief: "step two",
    });
  });

  it("takes the brief from the first user message, not a later one", () => {
    const later = taskLine("later").replace("Task: later", "something else");
    const entries = [subagentRun([{ id: "child-1", cwd: "/w", rest: [taskLine("first"), later] }])];
    expect(readAskOrigin(source(entries), FORWARDED, ROOT_ENV)?.brief).toBe("first");
  });

  it("gives the cwd alone when the child has no user message yet", () => {
    const entries = [subagentRun([{ id: "child-1", cwd: "/w" }])];
    const origin = readAskOrigin(source(entries), FORWARDED, ROOT_ENV);
    expect(origin).toEqual({ cwd: "/w", cwdOf: "requester" });
  });

  it("caps a long brief, keeping head and tail", () => {
    const long = `HEAD${"x".repeat(MAX_MESSAGE_CHARS * 2)}TAIL`;
    const entries = [subagentRun([{ id: "child-1", cwd: "/w", rest: [taskLine(long)] }])];
    const brief = readAskOrigin(source(entries), FORWARDED, ROOT_ENV)!.brief!;
    expect(brief.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(brief.startsWith("HEAD")).toBe(true);
    expect(brief.endsWith("TAIL")).toBe(true);
  });

  it("lets a pstack record win when both are present", () => {
    const entries = [
      subagentRun([{ id: "child-1", cwd: "/subagents", rest: [taskLine("from the child file")] }]),
      pstackAgent({ sessionId: "child-1", cwd: "/pstack", brief: "from the record" }),
    ];
    expect(readAskOrigin(source(entries), FORWARDED, ROOT_ENV)).toEqual({
      cwd: "/pstack",
      cwdOf: "requester",
      brief: "from the record",
    });
  });

  it("falls back unchanged when no run holds the session id", () => {
    const entries = [subagentRun([{ id: "other", cwd: "/w", rest: [taskLine("b")] }])];
    const origin = readAskOrigin(source(entries), FORWARDED, ROOT_ENV);
    expect(origin).toEqual(FALLBACK);
    expect(origin).not.toHaveProperty("brief");
  });

  it("falls back on a null requester session id", () => {
    const entries = [subagentRun([{ id: "child-1", cwd: "/w", rest: [taskLine("b")] }])];
    expect(readAskOrigin(source(entries), { forwarded: true, sessionId: null }, ROOT_ENV)).toEqual(
      FALLBACK,
    );
  });

  it("falls back on missing or malformed files, never throwing", () => {
    const missingDir = launchResult(join(scratch, "does-not-exist"));
    const badStatus = subagentRun([], { statusJson: "{not json" });
    const noSteps = subagentRun([], { statusJson: JSON.stringify({ steps: "nope" }) });
    const badSteps = subagentRun([], {
      statusJson: JSON.stringify({
        steps: [null, 7, {}, { sessionFile: 5 }, { sessionFile: "/nope/gone.jsonl" }],
      }),
    });
    const notSession = subagentRun([]);
    writeFileSync(
      join(scratch, `run-${nextRun}`, "status.json"),
      JSON.stringify({ steps: [{ sessionFile: join(scratch, `run-${nextRun}`, "x.jsonl") }] }),
    );
    writeFileSync(join(scratch, `run-${nextRun}`, "x.jsonl"), "garbage\n");
    const noDir = launchResult(undefined);
    const wrongTool = launchResult(join(scratch, "run-1"), "bash");
    const entries = [missingDir, badStatus, noSteps, badSteps, notSession, noDir, wrongTool];
    expect(readAskOrigin(source(entries), FORWARDED, ROOT_ENV)).toEqual(FALLBACK);
  });

  it("ignores a header that is not a session header", () => {
    const run = subagentRun([{ id: "child-1", cwd: "/w", rest: [taskLine("b")] }]);
    const dir = (run as unknown as { message: { details: { asyncDir: string } } }).message.details
      .asyncDir;
    writeFileSync(
      join(dir, "step-0.jsonl"),
      `${JSON.stringify({ type: "message", id: "child-1", cwd: "/w" })}\n${taskLine("b")}\n`,
    );
    expect(readAskOrigin(source([run]), FORWARDED, ROOT_ENV)).toEqual(FALLBACK);
  });

  it("scans only the newest launch results", () => {
    const old = subagentRun([{ id: "child-1", cwd: "/old", rest: [taskLine("too old")] }]);
    const filler = Array.from({ length: 32 }, () => subagentRun([{ id: "nope", cwd: "/n" }]));
    expect(readAskOrigin(source([old, ...filler]), FORWARDED, ROOT_ENV)).toEqual(FALLBACK);
  });

  it("skips a malformed message entry and still returns the matched child's cwd and brief", () => {
    const malformed = [
      JSON.stringify({ type: "message", id: "m0" }),
      JSON.stringify({
        type: "message",
        id: "m0b",
        message: { role: "user", content: 5 },
      }),
      JSON.stringify({
        type: "message",
        id: "m0c",
        message: { content: "no role" },
      }),
      JSON.stringify({ type: "message", id: "m0d", message: null }),
      JSON.stringify({
        type: "message",
        id: "m0e",
        message: { role: "user", content: [null, { type: "text", text: "half written" }] },
      }),
    ];
    const entries = [
      subagentRun([
        {
          id: "child-1",
          cwd: "/w",
          rest: [...malformed, taskLine("the real brief")],
        },
      ]),
    ];
    expect(readAskOrigin(source(entries), FORWARDED, ROOT_ENV)).toEqual({
      cwd: "/w",
      cwdOf: "requester",
      brief: "the real brief",
    });
  });

  it("reads only a small head of a file that does not match", () => {
    const entries = [
      subagentRun([
        { id: "other-1", cwd: "/a", rest: [taskLine("x".repeat(100_000))] },
        {
          id: "other-2",
          cwd: "/b",
          rest: ["\u0000\u0001 not json ".repeat(20_000)],
        },
      ]),
    ];
    readLengths.length = 0;
    expect(readAskOrigin(source(entries), FORWARDED, ROOT_ENV)).toEqual(FALLBACK);
    expect(readLengths.length).toBeGreaterThan(0);
    expect(Math.max(...readLengths)).toBeLessThanOrEqual(8 * 1024);
  });

  it("reads further only for the matching file, past the head, to find the brief", () => {
    const padding = JSON.stringify({
      type: "custom",
      id: "pad",
      data: "p".repeat(20_000),
    });
    const entries = [
      subagentRun([
        { id: "other", cwd: "/a", rest: [padding, taskLine("not me")] },
        {
          id: "child-1",
          cwd: "/w",
          rest: [padding, taskLine("after the head")],
        },
      ]),
    ];
    expect(readAskOrigin(source(entries), FORWARDED, ROOT_ENV)).toEqual({
      cwd: "/w",
      cwdOf: "requester",
      brief: "after the head",
    });
  });

  it("treats a header line cut by the head as no match", () => {
    const entries = [
      subagentRun([{ id: "child-1", cwd: "/w".padEnd(20_000, "w"), rest: [taskLine("b")] }]),
    ];
    expect(readAskOrigin(source(entries), FORWARDED, ROOT_ENV)).toEqual(FALLBACK);
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
