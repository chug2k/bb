# Move conversations between projects

Use `bb thread move` when the user wants an existing conversation to belong to
another project. It preserves thread IDs, history, provider session IDs, parent
links, archived/hidden/pinned state, prompt history, and uploaded attachments.
It changes the next turn's environment. It does not relocate working files,
checkouts, servers, or provider-owned workspaces.

Resolve the destination with `bb project list --json` and `bb environment list
--project <project-id> --json`. Use an existing ready environment in that project
on the source machine. If the user only wants a new working directory within the
same project, ensure the requested directory exists, call
`update_environment_directory`, and stop the turn after success.

Preview the exact selection:

```sh
bb thread move <thread-id> --project <project-id> --environment <environment-id> --include-children --check --json
```

`--include-children` includes all nondeleted descendants and lifecycle dependents,
including archived and hidden ones. Without it, only the explicit IDs move.
Related root threads are not descendants: add their IDs to the same command.
The limit is 200 threads per request. Check `.threads`, the destination `.path`,
and `.blockers`; a preview exits successfully even when blockers are listed.

Apply the same command without `--check` once the requested scope is correct and
blockers are resolved. Existing user authorization to move that scope is enough;
do not ask again simply because this workflow has a preview. A blocker is not
permission to discard queued messages, interrupt work, clear goals, or destroy
files. Leave that work intact unless the user has authorized that action.

Active, starting, stopping, unprovisioned, queued, interactive, and background
work cannot move. A running agent may preview itself with `--self`, but cannot
move itself mid-turn. Finish the turn and run the printed command from an
external terminal or an idle coordinating thread. Do not promise that ending the
turn schedules a move; this command has no deferred mode.

Moves also refuse a disconnected machine, a cross-machine destination, an
unready source/destination, split lifecycle ownership, missing attachments,
different bytes at the same target attachment path, or a last live thread whose
owned workspace might retire. Workspace migration is a separate operation;
this command does not change environment ownership or teardown policy. Do not
bypass a refusal by editing SQLite or rewriting provider session files. Do not
overwrite either attachment to clear a collision.

The server releases idle provider runtimes before changing ownership. It leaves
a provider-reported active turn running and refuses the move. The next turn
resumes with the destination project's settings, instructions and directory.
It rechecks the selection and commits all conversation ownership changes in one
transaction. Source attachment bytes stay available to other source threads;
a failed preparation can leave unowned copied attachments for normal cleanup.

Confirm using `bb thread show <id> --json` and `bb thread list --project
<project-id> --json`. Report the destination and any intentionally excluded
threads. Repeating a completed move is a no-op. The SDK path used by this CLI is
`threads.experimental_move({threadIds, projectId, environmentId,
includeChildren, check})`; both booleans default to false.
