import { describe, expect, it, vi } from "vitest";
import { createBbSdk } from "../src/core.js";
import { createHttpTransport } from "../src/transport-http.js";
import type { FetchImplementation } from "../src/response.js";

describe("thread move transport", () => {
  it("uses the shared batch route and carries cancellation outside the request body", async () => {
    const response = {
      moved: false,
      projectId: "proj_b",
      environmentId: "env_b",
      path: "/work",
      threads: [],
      blockers: [],
    };
    const fetch = vi.fn<FetchImplementation>(async () =>
      Response.json(response),
    );
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        runtime: "node",
        fetch,
      }),
    });
    const controller = new AbortController();
    const result = await sdk.threads.experimental_move({
      threadIds: ["thr_a"],
      projectId: "proj_b",
      environmentId: "env_b",
      includeChildren: true,
      check: true,
      signal: controller.signal,
    });
    expect(result).toEqual(response);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe("http://bb.test/api/v1/threads/move");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      threadIds: ["thr_a"],
      projectId: "proj_b",
      environmentId: "env_b",
      includeChildren: true,
      check: true,
    });
    expect(init?.signal).toBe(controller.signal);
  });
});
