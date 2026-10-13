import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  acquireProjectAttachmentOwnership,
  archiveThread,
  environments,
  events,
  getThread,
  getProjectAttachment,
  projectAttachmentThreads,
  promptHistoryEntries,
  recordProjectAttachment,
  threads,
  updateThread,
} from "@bb/db";
import { threadScope } from "@bb/domain";
import { moveThreadsResponseSchema } from "@bb/server-contract";
import type { MoveThreadsRequest } from "@bb/server-contract";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";
import {
  seedEnvironment,
  seedProjectWithSource,
  seedQueuedMessage,
  seedStoredEvent,
  seedThread,
  seedThreadFixture,
} from "../helpers/seed.js";
import {
  listQueuedThreadCommands,
  waitForQueuedCommand,
  reportQueuedCommandSuccess,
  reportQueuedCommandError,
} from "../helpers/commands.js";
import { withThreadSendGuard } from "../../src/services/threads/thread-context-mutation-guard.js";
import { readJson } from "../helpers/json.js";

function fixture(harness: TestAppHarness) {
  const source = seedThreadFixture(harness);
  const { project: target } = seedProjectWithSource(harness.deps, {
    hostId: source.host.id,
    name: "Destination",
    path: "/tmp/destination",
  });
  const destination = seedEnvironment(harness.deps, {
    hostId: source.host.id,
    projectId: target.id,
    path: "/tmp/destination",
  });
  const request: MoveThreadsRequest = {
    threadIds: [source.thread.id],
    projectId: target.id,
    environmentId: destination.id,
  };
  return { ...source, target, destination, request };
}

function move(harness: TestAppHarness, request: MoveThreadsRequest) {
  return harness.app.request("/api/v1/threads/move", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
}

async function release(
  harness: TestAppHarness,
  threadId: string,
  retained = false,
) {
  const command = await waitForQueuedCommand(
    harness,
    ({ command }) =>
      command.type === "thread.stop" && command.threadId === threadId,
  );
  expect(command.command).toMatchObject({ intent: "release" });
  await reportQueuedCommandSuccess(harness, command, {
    providerCheckpointId: null,
    activeTurnRetained: retained,
  });
}

async function attachment(
  harness: TestAppHarness,
  projectId: string,
  content: string,
  inventory = true,
) {
  const path = "sample.txt";
  await mkdir(join(harness.deps.config.dataDir, "attachments", projectId), {
    recursive: true,
  });
  await writeFile(
    join(harness.deps.config.dataDir, "attachments", projectId, path),
    content,
  );
  if (inventory)
    recordProjectAttachment(harness.db, {
      projectId,
      storedPath: path,
      originalName: "Original.txt",
      mimeType: "text/plain",
      sizeBytes: Buffer.byteLength(content),
      createdAt: 1,
      readyAt: 1,
    });
  return path;
}

describe("thread project moves", () => {
  it("previews without releasing runtimes or creating target attachments, then preserves identity/history and shared attachment owners", async () => {
    await withTestHarness(async (harness) => {
      const { thread, project, environment, destination, target, request } =
        fixture(harness);
      const other = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const path = await attachment(harness, project.id, "original bytes");
      acquireProjectAttachmentOwnership(harness.db, thread.id, [path]);
      acquireProjectAttachmentOwnership(harness.db, other.id, [path]);
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-session-preserved",
        type: "system/operation",
        scope: threadScope(),
        sequence: 1,
        data: {
          operation: "test",
          operationId: "operation-1",
          status: "completed",
          message: "history",
        },
      });
      harness.db
        .insert(promptHistoryEntries)
        .values({
          id: "prompt-1",
          projectId: project.id,
          threadId: thread.id,
          scope: "project",
          requestSequence: 1,
          input: JSON.stringify([{ type: "localFile", path }]),
          createdAt: 1,
        })
        .run();
      const beforeEvents = harness.db.select().from(events).all();
      const beforeThread = getThread(harness.db, thread.id);
      const notify = vi.spyOn(harness.deps.hub, "notifyProject");
      const preview = await move(harness, { ...request, check: true });
      expect(preview.status).toBe(200);
      expect(
        moveThreadsResponseSchema.parse(await readJson(preview)),
      ).toMatchObject({
        moved: false,
        blockers: [],
        threads: [
          { id: thread.id, attachmentCount: 1, previousPath: environment.path },
        ],
      });
      expect(getThread(harness.db, thread.id)).toEqual(beforeThread);
      expect(getProjectAttachment(harness.db, target.id, path)).toBeUndefined();
      expect(
        listQueuedThreadCommands(harness, "thread.stop", thread.id),
      ).toHaveLength(0);
      const pending = move(harness, request);
      await release(harness, thread.id);
      const response = await pending;
      expect(await response.clone().text()).not.toContain('"code":');
      expect(response.status).toBe(200);
      expect(
        moveThreadsResponseSchema.parse(await readJson(response)).moved,
      ).toBe(true);
      expect(getThread(harness.db, thread.id)).toEqual({
        ...beforeThread,
        projectId: target.id,
        environmentId: destination.id,
        updatedAt: expect.any(Number),
      });
      expect(harness.db.select().from(events).all()).toEqual(beforeEvents);
      expect(
        harness.db.select().from(promptHistoryEntries).get()?.projectId,
      ).toBe(target.id);
      const original = getProjectAttachment(harness.db, project.id, path)!;
      const copied = getProjectAttachment(harness.db, target.id, path)!;
      expect(copied.originalName).toBe("Original.txt");
      expect(
        harness.db
          .select()
          .from(projectAttachmentThreads)
          .where(eq(projectAttachmentThreads.attachmentId, original.id))
          .all(),
      ).toEqual([{ threadId: other.id, attachmentId: original.id }]);
      expect(
        harness.db
          .select()
          .from(projectAttachmentThreads)
          .where(eq(projectAttachmentThreads.attachmentId, copied.id))
          .all(),
      ).toEqual([{ threadId: thread.id, attachmentId: copied.id }]);
      expect(
        await readFile(
          join(harness.deps.config.dataDir, "attachments", target.id, path),
          "utf8",
        ),
      ).toBe("original bytes");
      expect(notify).toHaveBeenCalledWith(project.id, ["threads-changed"]);
      expect(notify).toHaveBeenCalledWith(target.id, ["threads-changed"]);
      const repeat = await move(harness, request);
      expect(
        moveThreadsResponseSchema.parse(await readJson(repeat)),
      ).toMatchObject({ moved: false, blockers: [] });
    });
  });

  it("includes archived/hidden descendants and lifecycle dependents only when requested", async () => {
    await withTestHarness(async (harness) => {
      const { thread, project, environment, request } = fixture(harness);
      const child = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        parentThreadId: thread.id,
        visibility: "hidden",
      });
      archiveThread(harness.db, harness.deps.hub, child.id);
      const dependent = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        lifecycleOwnerThreadId: thread.id,
      });
      const single = moveThreadsResponseSchema.parse(
        await readJson(await move(harness, { ...request, check: true })),
      );
      expect(single.threads.map((row) => row.id)).toEqual([thread.id]);
      expect(single.blockers).toEqual([
        expect.objectContaining({ threadId: dependent.id }),
      ]);
      const batchRequest = { ...request, includeChildren: true };
      const preview = moveThreadsResponseSchema.parse(
        await readJson(await move(harness, { ...batchRequest, check: true })),
      );
      expect(preview.blockers).toEqual([]);
      expect(preview.threads.map((row) => row.id).sort()).toEqual(
        [thread.id, child.id, dependent.id].sort(),
      );
      const pending = move(harness, batchRequest);
      for (const id of preview.threads.map((row) => row.id).sort())
        await release(harness, id);
      expect((await pending).status).toBe(200);
      expect(getThread(harness.db, child.id)).toMatchObject({
        projectId: request.projectId,
        parentThreadId: thread.id,
        archivedAt: expect.any(Number),
        visibility: "hidden",
      });
      expect(getThread(harness.db, dependent.id)?.lifecycleOwnerThreadId).toBe(
        thread.id,
      );
    });
  });

  it.each(["active", "starting", "stopping", "pending"] as const)(
    "refuses %s threads without sending stop commands",
    async (status) => {
      await withTestHarness(async (harness) => {
        const { thread, request, project } = fixture(harness);
        harness.db
          .update(threads)
          .set({ status })
          .where(eq(threads.id, thread.id))
          .run();
        expect((await move(harness, request)).status).toBe(409);
        expect(getThread(harness.db, thread.id)?.projectId).toBe(project.id);
        expect(
          listQueuedThreadCommands(harness, "thread.stop", thread.id),
        ).toHaveLength(0);
      });
    },
  );

  it("refuses queued messages and a foreign destination environment", async () => {
    await withTestHarness(async (harness) => {
      const { thread, environment, request } = fixture(harness);
      seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: [{ type: "text", text: "later", mentions: [] }],
      });
      expect((await move(harness, request)).status).toBe(409);
      expect(
        (await move(harness, { ...request, environmentId: environment.id }))
          .status,
      ).toBe(400);
      expect(
        listQueuedThreadCommands(harness, "thread.stop", thread.id),
      ).toHaveLength(0);
    });
  });

  it.each([true, false])(
    "refuses target content collisions (inventoried: %s), preserving both copies",
    async (inventoried) => {
      await withTestHarness(async (harness) => {
        const { thread, project, target, request } = fixture(harness);
        const path = await attachment(harness, project.id, "source");
        acquireProjectAttachmentOwnership(harness.db, thread.id, [path]);
        await attachment(harness, target.id, "different", inventoried);
        expect((await move(harness, request)).status).toBe(409);
        expect(getThread(harness.db, thread.id)?.projectId).toBe(project.id);
        expect(
          await readFile(
            join(harness.deps.config.dataDir, "attachments", target.id, path),
            "utf8",
          ),
        ).toBe("different");
        expect(
          listQueuedThreadCommands(harness, "thread.stop", thread.id),
        ).toHaveLength(0);
      });
    },
  );

  it("finds legacy attachments in history even before inventory backfill", async () => {
    await withTestHarness(async (harness) => {
      const { thread, project, target, request } = fixture(harness);
      const path = await attachment(harness, project.id, "legacy", false);
      harness.db
        .insert(promptHistoryEntries)
        .values({
          id: "legacy",
          projectId: project.id,
          threadId: thread.id,
          scope: "thread",
          requestSequence: 1,
          input: JSON.stringify([{ type: "localFile", path }]),
          createdAt: 1,
        })
        .run();
      const pending = move(harness, request);
      await release(harness, thread.id);
      expect((await pending).status).toBe(200);
      expect(
        getProjectAttachment(harness.db, target.id, path)?.readyAt,
      ).not.toBeNull();
    });
  });

  it("leaves a provider-retained active turn running and keeps project ownership", async () => {
    await withTestHarness(async (harness) => {
      const { thread, project, request } = fixture(harness);
      const pending = move(harness, request);
      await release(harness, thread.id, true);
      expect((await pending).status).toBe(409);
      expect(getThread(harness.db, thread.id)?.projectId).toBe(project.id);
      expect(
        listQueuedThreadCommands(harness, "thread.stop", thread.id).some(
          (command) =>
            command.type === "thread.stop" && command.intent === "interrupt",
        ),
      ).toBe(false);
    });
  });

  it("blocks concurrent sends and aborts if metadata changes during release", async () => {
    await withTestHarness(async (harness) => {
      const { thread, request, project } = fixture(harness);
      const pending = move(harness, request);
      const command = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "thread.stop",
      );
      await expect(
        withThreadSendGuard(thread.id, async () => "sent"),
      ).rejects.toThrow("moving to another project");
      updateThread(harness.db, harness.deps.hub, thread.id, {
        title: "concurrent edit",
      });
      await reportQueuedCommandSuccess(harness, command, {
        providerCheckpointId: null,
      });
      expect((await pending).status).toBe(409);
      expect(getThread(harness.db, thread.id)?.projectId).toBe(project.id);
      await expect(
        withThreadSendGuard(thread.id, async () => "sent"),
      ).resolves.toBe("sent");
    });
  });

  it("does not move any batch member when the second runtime fails to release", async () => {
    await withTestHarness(async (harness) => {
      const { thread, project, environment, request } = fixture(harness);
      const other = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const ids = [thread.id, other.id].sort();
      const pending = move(harness, { ...request, threadIds: ids });
      await release(harness, ids[0]);
      const command = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === ids[1],
      );
      await reportQueuedCommandError(harness, command, {
        errorCode: "command_failed",
        errorMessage: "offline",
      });
      expect((await pending).status).toBeGreaterThanOrEqual(400);
      expect(ids.map((id) => getThread(harness.db, id)?.projectId)).toEqual([
        project.id,
        project.id,
      ]);
    });
  });
  it.each([
    "different-host",
    "unready-target",
    "owned-source",
    "missing-attachment",
  ])("refuses unsafe preparation: %s", async (reason) => {
    await withTestHarness(async (harness) => {
      const { thread, project, environment, destination, request } =
        fixture(harness);
      if (reason === "different-host") {
        const other = seedThreadFixture(harness, {
          session: { id: "host-other" },
        });
        harness.db
          .update(environments)
          .set({ hostId: other.host.id })
          .where(eq(environments.id, destination.id))
          .run();
      }
      if (reason === "unready-target")
        harness.db
          .update(environments)
          .set({ status: "destroyed" })
          .where(eq(environments.id, destination.id))
          .run();
      if (reason === "owned-source")
        harness.db
          .update(environments)
          .set({ providerOwnsPath: true })
          .where(eq(environments.id, environment.id))
          .run();
      if (reason === "missing-attachment") {
        recordProjectAttachment(harness.db, {
          projectId: project.id,
          storedPath: "absent",
          originalName: "absent",
          mimeType: null,
          sizeBytes: 1,
          createdAt: 1,
          readyAt: 1,
        });
        acquireProjectAttachmentOwnership(harness.db, thread.id, ["absent"]);
      }
      const before = getThread(harness.db, thread.id);
      expect((await move(harness, request)).status).toBeGreaterThanOrEqual(400);
      expect(getThread(harness.db, thread.id)).toEqual(before);
      expect(
        listQueuedThreadCommands(harness, "thread.stop", thread.id),
      ).toHaveLength(0);
    });
  });

  it("rolls back the whole batch if a database constraint rejects the second update", async () => {
    await withTestHarness(async (harness) => {
      const { thread, project, environment, request } = fixture(harness);
      const other = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const ids = [thread.id, other.id].sort();
      harness.db.$client.exec(
        `CREATE TRIGGER fail_move BEFORE UPDATE OF project_id ON threads WHEN OLD.id = '${ids[1]}' BEGIN SELECT RAISE(ABORT, 'test rollback'); END`,
      );
      const pending = move(harness, { ...request, threadIds: ids });
      for (const id of ids) await release(harness, id);
      expect((await pending).status).toBe(500);
      expect(ids.map((id) => getThread(harness.db, id)?.projectId)).toEqual([
        project.id,
        project.id,
      ]);
    });
  });
});
