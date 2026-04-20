import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm } from "fs/promises";
import { randomUUID } from "crypto";
import os from "os";
import path from "path";
import {
  QueryLogger,
  type QueryLogEntry,
} from "../src/logging/query-logger.js";

type QueryLoggerPrivateApi = {
  getAllQueries: (limit?: number) => Promise<QueryLogEntry[]>;
  filterQueries: (
    predicate: (entry: QueryLogEntry) => boolean,
    limit?: number
  ) => Promise<QueryLogEntry[]>;
};

type QueryEntryInput = Omit<QueryLogEntry, "timestamp" | "queryId">;

function createEntry(overrides: Partial<QueryEntryInput> = {}): QueryEntryInput {
  return {
    sessionId: "session-default",
    notebookId: "notebook-1",
    notebookUrl: "https://notebooklm.google.com/notebook/test",
    notebookName: "Test Notebook",
    question: "What is the summary?",
    answer: "This is a test answer.",
    answerLength: "This is a test answer.".length,
    durationMs: 123,
    quotaInfo: {
      used: 1,
      limit: 50,
      remaining: 49,
      tier: "free",
    },
    ...overrides,
  };
}

describe("QueryLogger", () => {
  let tempDir: string;
  let logger: QueryLogger;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `ql-test-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });

    logger = new QueryLogger({
      enabled: true,
      logDir: tempDir,
      retentionDays: 90,
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("logQuery persists entry", async () => {
    const entry = createEntry({
      sessionId: "session-persist",
      question: "Persist me",
      answer: "Persisted answer",
      answerLength: "Persisted answer".length,
    });

    const queryId = await logger.logQuery(entry);
    await logger.flush();

    const entries = await (logger as unknown as QueryLoggerPrivateApi).getAllQueries(10);
    const persistedEntry = entries.find(saved => saved.queryId === queryId);

    expect(persistedEntry).toBeDefined();
    expect(persistedEntry).toMatchObject({
      sessionId: "session-persist",
      question: "Persist me",
      answer: "Persisted answer",
      notebookUrl: "https://notebooklm.google.com/notebook/test",
    });
  });

  it("getAllQueries respects limit", async () => {
    for (let index = 0; index < 5; index++) {
      const answer = `Answer ${index}`;
      await logger.logQuery(createEntry({
        sessionId: `session-${index}`,
        question: `Question ${index}`,
        answer,
        answerLength: answer.length,
      }));
    }

    await logger.flush();

    const entries = await (logger as unknown as QueryLoggerPrivateApi).getAllQueries(3);

    expect(entries).toHaveLength(3);
  });

  it("filterQueries selects matching entries", async () => {
    await logger.logQuery(createEntry({
      sessionId: "target-session",
      question: "Question A",
      answer: "Answer A",
      answerLength: "Answer A".length,
    }));
    await logger.logQuery(createEntry({
      sessionId: "other-session",
      question: "Question B",
      answer: "Answer B",
      answerLength: "Answer B".length,
    }));
    await logger.logQuery(createEntry({
      sessionId: "target-session",
      question: "Question C",
      answer: "Answer C",
      answerLength: "Answer C".length,
    }));

    await logger.flush();

    const entries = await (logger as unknown as QueryLoggerPrivateApi).filterQueries(
      entry => entry.sessionId === "target-session",
      10
    );

    expect(entries).toHaveLength(2);
    expect(entries.every(entry => entry.sessionId === "target-session")).toBe(true);
  });

  it("getAllQueries returns empty array when no files", async () => {
    const entries = await (logger as unknown as QueryLoggerPrivateApi).getAllQueries(10);

    expect(entries).toEqual([]);
  });

  it("Secrets are not logged in plaintext", async () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";

    await logger.logQuery(createEntry({
      sessionId: "secret-session",
      answer: `Leaked credential: ${secret}`,
      answerLength: `Leaked credential: ${secret}`.length,
    }));

    await logger.flush();

    const entries = await (logger as unknown as QueryLoggerPrivateApi).getAllQueries(10);
    const storedEntry = entries.find(entry => entry.sessionId === "secret-session");

    expect(storedEntry).toBeDefined();
    expect(storedEntry?.answer).not.toContain(secret);
  });
});
