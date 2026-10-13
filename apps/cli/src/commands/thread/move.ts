import { Command } from "commander";
import { action } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { outputJson, requireThreadIdOrSelf } from "../helpers.js";

interface MoveOptions {
  project: string;
  environment: string;
  includeChildren?: boolean;
  check?: boolean;
  self?: boolean;
  json?: boolean;
}

export function registerMoveCommand(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("move [ids...]")
    .description(
      "Move idle conversations to a project's existing environment on the same machine; working files stay in place",
    )
    .requiredOption("--project <id>", "Destination project ID")
    .requiredOption(
      "--environment <id>",
      "Destination environment ID (sets the next turn's directory)",
    )
    .option("--self", "Select the current thread (must be idle to move)")
    .option(
      "--include-children",
      "Include archived/hidden descendants and lifecycle dependents",
    )
    .option(
      "--check",
      "Preview selection and blockers without changing anything",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (ids: string[], opts: MoveOptions) => {
        if (opts.self && ids.length > 0)
          throw new Error("Use thread IDs or --self, not both.");
        const threadIds =
          ids.length > 0 ? ids : [requireThreadIdOrSelf(undefined, opts)];
        const result = await createCliBbSdk(getUrl()).threads.experimental_move(
          {
            threadIds,
            projectId: opts.project,
            environmentId: opts.environment,
            includeChildren: opts.includeChildren ?? false,
            check: opts.check ?? false,
          },
        );
        if (outputJson(opts, result)) return;
        console.log(
          `${opts.check ? "Move preview" : result.moved ? "Moved" : "Already assigned"}: ${result.projectId} / ${result.environmentId}`,
        );
        console.log(
          `Next-turn directory: ${result.path}. Working files are not moved.`,
        );
        for (const thread of result.threads)
          console.log(
            `${thread.id}: ${thread.previousProjectId} → ${result.projectId}; ${thread.attachmentCount} attachment(s)`,
          );
        for (const blocker of result.blockers)
          console.log(`Blocked ${blocker.threadId}: ${blocker.message}`);
      }),
    );
}
