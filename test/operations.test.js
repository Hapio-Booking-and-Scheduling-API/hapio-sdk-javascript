import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHapioClient } from "../src/index.js";
import { operations } from "../src/generated/operations.js";

// Table-driven checks over every generated operation, so a generator regression shows up here.

/**
 * @param {(url: string, init: RequestInit) => void} onRequest
 */
function recordingFetch(onRequest) {
  return /** @type {typeof fetch} */ (async (url, init) => {
    onRequest(String(url), init ?? {});
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  });
}

describe("generated operations", () => {
  const entries = Object.entries(operations);

  it("has the expected number of operations with unique method and path pairs", () => {
    assert.equal(entries.length, 60);
    const pairs = entries.map(([, op]) => `${op.method} ${op.path}`);
    assert.equal(new Set(pairs).size, pairs.length);
  });

  it("names the recurring schedule block operations consistently", () => {
    const names = Object.keys(operations).filter((id) => /RecurringScheduleBlock/.test(id)).sort();
    assert.deepEqual(names, [
      "deleteResourceRecurringScheduleBlock",
      "getResourceRecurringScheduleBlock",
      "getResourceRecurringScheduleBlocks",
      "patchResourceRecurringScheduleBlock",
      "postResourceRecurringScheduleBlock",
      "putResourceRecurringScheduleBlock",
    ]);
    assert.ok(!("putResourceRecurringScheduleScheduleBlock" in operations));
  });

  it("does not collide with built-in client properties", () => {
    const hapio = createHapioClient({ fetch: recordingFetch(() => {}) });
    for (const [id] of entries) {
      assert.equal(typeof hapio[id], "function", id);
    }
    assert.equal(typeof hapio.request, "function");
    assert.equal(hapio.operations, operations);
  });

  for (const [id, op] of entries) {
    describe(id, () => {
      const placeholders = [...op.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);

      it("declares exactly the path placeholders as path params", () => {
        assert.deepEqual(op.params?.path ?? [], placeholders);
      });

      it("uses a known method, and a JSON body type only for methods that take a body", () => {
        assert.ok(["GET", "POST", "PUT", "PATCH", "DELETE"].includes(op.method));
        if (op.defaultContentType) {
          assert.ok(["POST", "PUT", "PATCH"].includes(op.method));
          assert.equal(op.defaultContentType, "application/json");
        }
      });

      it("calls the right method and URL", async () => {
        /** @type {{ url: string, init: RequestInit } | undefined} */
        let seen;
        const hapio = createHapioClient({
          token: "t",
          baseUrl: "https://example.test/v1",
          fetch: recordingFetch((url, init) => (seen = { url, init })),
        });
        const path = Object.fromEntries(placeholders.map((p) => [p, `${p}-id`]));
        const body = op.defaultContentType ? { example: true } : undefined;
        await hapio[id]({ path, body });

        assert.ok(seen);
        assert.equal(seen.init.method, op.method);
        assert.equal(seen.url, `https://example.test/v1${op.path.replace(/\{([^}]+)\}/g, "$1-id")}`);
        assert.equal(seen.init.body, body ? JSON.stringify(body) : undefined);
      });

      if (placeholders.length) {
        it("refuses to run without its path params", async () => {
          const hapio = createHapioClient({ fetch: recordingFetch(() => assert.fail("should not call fetch")) });
          await assert.rejects(() => hapio[id](), /Missing required path param/);
        });
      }
    });
  }
});
