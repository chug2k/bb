import { describe, expect, it, vi } from "vitest";
import {
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

const result = {
  moved: false,
  projectId: "proj_target",
  environmentId: "env_target",
  path: "/work/project",
  threads: [
    {
      id: "thr_one",
      previousProjectId: "proj_source",
      previousEnvironmentId: "env_source",
      previousPath: "/old",
      attachmentCount: 2,
      changed: true,
    },
  ],
  blockers: [],
};

describe("bb thread move", () => {
  setupCommandOutputTestEnvironment();
  const register: CommandRegistrar = (program) =>
    registerThreadCommands(program, () => "http://server");

  it("passes batch scope and read-only preview to the shared SDK route", async () => {
    const move = vi.fn(async () => result);
    stubServerApi({ "v1.threads.move.$post": move });
    await runCommand(
      [
        "thread",
        "move",
        "thr_one",
        "thr_two",
        "--project",
        "proj_target",
        "--environment",
        "env_target",
        "--include-children",
        "--check",
        "--json",
      ],
      register,
    );
    expect(move).toHaveBeenCalledExactlyOnceWith({
      json: {
        threadIds: ["thr_one", "thr_two"],
        projectId: "proj_target",
        environmentId: "env_target",
        includeChildren: true,
        check: true,
      },
    });
    expect(console.log).toHaveBeenCalledWith(JSON.stringify(result, null, 2));
  });

  it("prints preview blockers and the destination directory", async () => {
    stubServerApi({
      "v1.threads.move.$post": vi.fn(async () => ({
        ...result,
        blockers: [{ threadId: "thr_one", message: "Wait until idle" }],
      })),
    });
    await runCommand(
      [
        "thread",
        "move",
        "thr_one",
        "--project",
        "proj_target",
        "--environment",
        "env_target",
        "--check",
      ],
      register,
    );
    expect(console.log).toHaveBeenCalledWith(
      "Next-turn directory: /work/project. Working files are not moved.",
    );
    expect(console.log).toHaveBeenCalledWith(
      "Blocked thr_one: Wait until idle",
    );
  });

  it("resolves --self and rejects combining it with IDs", async () => {
    vi.stubEnv("BB_THREAD_ID", "thr_current");
    const move = vi.fn(async () => result);
    stubServerApi({ "v1.threads.move.$post": move });
    await runCommand(
      [
        "thread",
        "move",
        "--self",
        "--project",
        "proj_target",
        "--environment",
        "env_target",
        "--check",
      ],
      register,
    );
    expect(move).toHaveBeenCalledWith({
      json: {
        threadIds: ["thr_current"],
        projectId: "proj_target",
        environmentId: "env_target",
        includeChildren: false,
        check: true,
      },
    });
    await expect(
      runCommand(
        [
          "thread",
          "move",
          "thr_one",
          "--self",
          "--project",
          "proj_target",
          "--environment",
          "env_target",
        ],
        register,
      ),
    ).rejects.toThrow("process.exit:1");
    expect(move).toHaveBeenCalledTimes(1);
  });
});
