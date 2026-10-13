import {
  providerEnvironmentHasPendingWork,
  refreshProviderRetirement,
} from "../environments/environment-engine.js";
import { and, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import {
  acquireProjectAttachmentOwnership,
  events,
  getEnvironment,
  getLatestThreadSequence,
  getProjectAttachment,
  listActiveBackgroundTaskCountsByThreadIds,
  listQueuedThreadMessages,
  projectAttachments,
  projectAttachmentThreads,
  promptHistoryEntries,
  threads,
} from "@bb/db";
import { storedAttachmentPaths } from "@bb/domain";
import type {
  MoveThreadsRequest,
  MoveThreadsResponse,
} from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import {
  requirePublicProject,
  requirePublicThread,
} from "../lib/entity-lookup.js";
import {
  copyProjectAttachments,
  readAttachment,
} from "../projects/attachments.js";
import {
  runLiveHostCommand,
  LIVE_DAEMON_COMMAND_TIMEOUT_MS,
} from "../hosts/live-command.js";
import { buildThreadStopCommand } from "./thread-commands.js";
import { withThreadProjectMoveGuard } from "./thread-context-mutation-guard.js";
import {
  hasLiveThreadStartInFlight,
  hasLiveThreadStopInFlight,
} from "./thread-lifecycle.js";
import { getThreadPromptBannerActivity } from "./thread-runtime-display.js";

function selection(deps: AppDeps, request: MoveThreadsRequest): string[] {
  for (const id of request.threadIds) requirePublicThread(deps.db, id);
  const ids = request.includeChildren
    ? deps.db
        .all<{ id: string }>(sql`
        WITH RECURSIVE selected(id) AS (
          SELECT id FROM threads WHERE ${inArray(threads.id, request.threadIds)}
          UNION
          SELECT t.id FROM threads t JOIN selected s
            ON t.parent_thread_id = s.id OR t.lifecycle_owner_thread_id = s.id
          WHERE t.deleted_at IS NULL
        ) SELECT id FROM selected LIMIT 201
      `)
        .map((row) => row.id)
    : [...new Set(request.threadIds)];
  if (ids.length > 200)
    throw new ApiError(
      400,
      "invalid_request",
      "Move at most 200 threads at a time",
    );
  return ids.sort();
}

function attachmentPaths(deps: AppDeps, threadId: string): string[] {
  const owned = deps.db
    .select({ path: projectAttachments.storedPath })
    .from(projectAttachmentThreads)
    .innerJoin(
      projectAttachments,
      eq(projectAttachments.id, projectAttachmentThreads.attachmentId),
    )
    .where(eq(projectAttachmentThreads.threadId, threadId))
    .all();
  const inputs = deps.db
    .select({ input: events.data })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        eq(events.type, "client/turn/requested"),
      ),
    )
    .all();
  const history = deps.db
    .select({ input: promptHistoryEntries.input })
    .from(promptHistoryEntries)
    .where(eq(promptHistoryEntries.threadId, threadId))
    .all();
  return [
    ...new Set([
      ...owned.map((row) => row.path),
      ...inputs.flatMap((row) => storedAttachmentPaths(row.input)),
      ...history.flatMap((row) => storedAttachmentPaths(row.input)),
    ]),
  ].sort();
}

function planMove(deps: AppDeps, request: MoveThreadsRequest) {
  requirePublicProject(deps.db, request.projectId);
  const destination = getEnvironment(deps.db, request.environmentId);
  if (!destination || destination.projectId !== request.projectId) {
    throw new ApiError(
      400,
      "invalid_request",
      "Destination environment must belong to the destination project",
    );
  }
  if (
    destination.status !== "ready" ||
    !destination.path ||
    destination.teardownStatus === "running"
  ) {
    throw new ApiError(
      409,
      "invalid_request",
      "Destination environment must be ready with a directory",
    );
  }
  const ids = selection(deps, request);
  const selected = ids.map((id) => requirePublicThread(deps.db, id));
  const blockers: MoveThreadsResponse["blockers"] = [];
  const block = (threadId: string, message: string) =>
    blockers.push({ threadId, message });
  const entries = selected.map((thread) => {
    const source =
      thread.environmentId === null
        ? null
        : getEnvironment(deps.db, thread.environmentId);
    const paths = attachmentPaths(deps, thread.id);
    const changed =
      thread.projectId !== request.projectId ||
      thread.environmentId !== destination.id;
    if (changed) {
      if (
        (thread.status !== "idle" && thread.status !== "error") ||
        hasLiveThreadStartInFlight(thread.id) ||
        hasLiveThreadStopInFlight(thread.id)
      ) {
        block(
          thread.id,
          "Wait until the thread is idle or failed before moving it",
        );
      }
      if (
        !source ||
        source.status !== "ready" ||
        !source.path ||
        source.teardownStatus === "running"
      ) {
        block(
          thread.id,
          "Restore the source environment before moving this thread",
        );
      } else if (source.hostId !== destination.hostId) {
        block(
          thread.id,
          "Destination must be on the same machine to preserve provider sessions and thread storage",
        );
      }
      if (!deps.hub.getDaemonSessionIdForHost(destination.hostId))
        block(
          thread.id,
          "Connect the machine before moving so its idle provider sessions can be released",
        );
      if (listQueuedThreadMessages(deps.db, thread.id).length > 0)
        block(thread.id, "Send or remove queued messages before moving");
      if (
        deps.pendingInteractions.listPendingThreadInteractions(thread.id)
          .length > 0
      )
        block(thread.id, "Resolve pending interactions before moving");
      if (providerEnvironmentHasPendingWork(deps.db, thread.id))
        block(
          thread.id,
          "Wait for environment provisioning or cleanup to finish",
        );
      const banner = getThreadPromptBannerActivity(deps, thread);
      if (banner.activeGoalCount > 0 || banner.activePlanModeCount > 0)
        block(thread.id, "Finish the active goal or plan before moving");
      if (source?.providerOwnsPath) {
        const retained = deps.db
          .select({ id: threads.id })
          .from(threads)
          .where(
            and(
              eq(threads.environmentId, source.id),
              isNull(threads.deletedAt),
              isNull(threads.archivedAt),
              notInArray(threads.id, ids),
            ),
          )
          .limit(1)
          .get();
        if (!retained && destination.id !== source.id)
          block(
            thread.id,
            "Moving the last live thread out of an owned workspace could retire its files; migrate or retain that workspace separately first",
          );
      }
    }
    return {
      thread,
      source,
      paths,
      changed,
      sequence: getLatestThreadSequence(deps.db, { threadId: thread.id }),
    };
  });
  for (const activity of listActiveBackgroundTaskCountsByThreadIds(deps.db, {
    threadIds: entries
      .filter((entry) => entry.changed)
      .map((entry) => entry.thread.id),
  })) {
    if (
      activity.activeBackgroundAgentCount +
        activity.activeBackgroundCommandCount +
        activity.activeWorkflowCount >
      0
    )
      block(
        activity.threadId,
        "Wait for background work to finish before moving",
      );
  }
  const related = deps.db
    .select()
    .from(threads)
    .where(
      and(
        isNull(threads.deletedAt),
        or(
          inArray(threads.lifecycleOwnerThreadId, ids),
          inArray(
            threads.id,
            selected.flatMap((thread) =>
              thread.lifecycleOwnerThreadId
                ? [thread.lifecycleOwnerThreadId]
                : [],
            ),
          ),
        ),
      ),
    )
    .all();
  for (const thread of related) {
    if (!ids.includes(thread.id) && thread.projectId !== request.projectId)
      block(
        thread.id,
        "Include this lifecycle owner or dependent in the move (use --include-children for dependents)",
      );
  }
  const response: MoveThreadsResponse = {
    moved: false,
    projectId: request.projectId,
    environmentId: destination.id,
    path: destination.path,
    threads: entries.map(({ thread, source, paths, changed }) => ({
      id: thread.id,
      previousProjectId: thread.projectId,
      previousEnvironmentId: thread.environmentId,
      previousPath: source?.path ?? null,
      attachmentCount: paths.length,
      changed,
    })),
    blockers,
  };
  return { ids, destination, entries, response };
}

type MovePlan = ReturnType<typeof planMove>;

function refuseBlocked(plan: MovePlan): void {
  if (plan.response.blockers.length > 0) {
    throw new ApiError(
      409,
      "thread_move_blocked",
      plan.response.blockers
        .map((blocker) => `${blocker.threadId}: ${blocker.message}`)
        .join("; "),
      { details: plan.response },
    );
  }
}

function fingerprint(plan: MovePlan): string {
  return JSON.stringify({
    destination: plan.destination,
    entries: plan.entries,
    ids: plan.ids,
  });
}

async function verifyAttachments(
  deps: AppDeps,
  plan: MovePlan,
  copied: boolean,
): Promise<void> {
  for (const entry of plan.entries) {
    if (!entry.changed || entry.thread.projectId === plan.response.projectId)
      continue;
    for (const path of entry.paths) {
      const source = await readAttachment(
        deps.config.dataDir,
        entry.thread.projectId,
        path,
      );
      const inventory = getProjectAttachment(
        deps.db,
        plan.response.projectId,
        path,
      );
      if (
        inventory &&
        (inventory.readyAt === null || inventory.deletionClaimedAt !== null)
      )
        throw new ApiError(
          409,
          "thread_move_blocked",
          `Destination attachment ${path} is unavailable`,
        );
      let target;
      try {
        target = await readAttachment(
          deps.config.dataDir,
          plan.response.projectId,
          path,
        );
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.status === 404 &&
          !copied &&
          !inventory
        )
          continue;
        throw error;
      }
      if (!source.content.equals(target.content))
        throw new ApiError(
          409,
          "thread_move_blocked",
          `Attachment ${path} has different contents in the destination project`,
        );
    }
  }
}

export async function moveThreads(
  deps: AppDeps,
  request: MoveThreadsRequest,
): Promise<MoveThreadsResponse> {
  const initial = planMove(deps, request);
  if (request.check) {
    for (const entry of initial.entries) {
      try {
        await verifyAttachments(deps, { ...initial, entries: [entry] }, false);
      } catch (error) {
        initial.response.blockers.push({
          threadId: entry.thread.id,
          message:
            error instanceof Error
              ? error.message
              : "Attachment validation failed",
        });
      }
    }
    return initial.response;
  }
  refuseBlocked(initial);
  if (!initial.entries.some((entry) => entry.changed)) return initial.response;
  return withThreadProjectMoveGuard(initial.ids, async () => {
    const plan = planMove(deps, request);
    refuseBlocked(plan);
    if (fingerprint(plan) !== fingerprint(initial))
      throw new ApiError(
        409,
        "thread_move_changed",
        "Move selection changed; run --check again",
      );
    await verifyAttachments(deps, plan, false);
    for (const entry of plan.entries) {
      if (!entry.changed || !entry.source) continue;
      const result = await runLiveHostCommand(deps, {
        hostId: entry.source.hostId,
        command: buildThreadStopCommand({
          hostId: entry.source.hostId,
          threadId: entry.thread.id,
          environmentId: entry.source.id,
          intent: "release",
        }),
        timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
      });
      if (result.activeTurnRetained)
        throw new ApiError(
          409,
          "thread_move_blocked",
          `${entry.thread.id}: the provider is still active; the turn was left running`,
        );
    }
    for (const entry of plan.entries) {
      if (!entry.changed) continue;
      for (const path of entry.paths) {
        await copyProjectAttachments(
          deps.db,
          deps.config.dataDir,
          entry.thread.projectId,
          request.projectId,
          [path],
        );
      }
    }
    await verifyAttachments(deps, plan, true);
    deps.db.transaction(
      (tx) => {
        const current = planMove(deps, request);
        refuseBlocked(current);
        if (fingerprint(current) !== fingerprint(plan))
          throw new ApiError(
            409,
            "thread_move_changed",
            "Threads or environments changed while preparing the move; run --check again",
          );
        for (const entry of plan.entries) {
          if (!entry.changed) continue;
          tx.update(threads)
            .set({
              projectId: request.projectId,
              environmentId: request.environmentId,
              updatedAt: Date.now(),
            })
            .where(eq(threads.id, entry.thread.id))
            .run();
          tx.update(promptHistoryEntries)
            .set({ projectId: request.projectId })
            .where(eq(promptHistoryEntries.threadId, entry.thread.id))
            .run();
          tx.delete(projectAttachmentThreads)
            .where(eq(projectAttachmentThreads.threadId, entry.thread.id))
            .run();
          acquireProjectAttachmentOwnership(tx, entry.thread.id, entry.paths);
        }
      },
      { behavior: "immediate" },
    );
    refreshProviderRetirement(deps, request.environmentId);
    for (const entry of plan.entries) {
      if (!entry.changed) continue;
      deps.hub.notifyThread(
        entry.thread.id,
        ["project-changed", "environment-changed"],
        { projectId: request.projectId },
      );
    }
    for (const projectId of new Set([
      request.projectId,
      ...plan.entries.map((entry) => entry.thread.projectId),
    ]))
      deps.hub.notifyProject(projectId, ["threads-changed"]);
    return { ...plan.response, moved: true };
  });
}
