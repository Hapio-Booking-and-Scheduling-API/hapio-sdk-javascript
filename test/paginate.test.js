import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import { createHapioClient, HapioError } from "../src/index.js";
import { operations } from "../src/generated/operations.js";

// A small local server that behaves like the Hapio list endpoints: `page` and `per_page` query
// parameters, and a `{ data, links, meta }` response (per_page is 100 when not given).

/** @type {{ url: string, headers: http.IncomingHttpHeaders }[]} */
let seen = [];
let total = 0;
/** @type {"full" | "links-only" | "bare"} */
let mode = "full";
/** @type {((page: number) => { status: number, body: unknown, headers?: Record<string, string> } | undefined) | undefined} */
let override;

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "", "http://localhost");
  seen.push({ url: req.url ?? "", headers: req.headers });
  const page = Number(url.searchParams.get("page") ?? 1);
  const perPage = Number(url.searchParams.get("per_page") ?? 100);

  const custom = override?.(page);
  if (custom) {
    res.writeHead(custom.status, { "content-type": "application/json", ...custom.headers });
    return res.end(JSON.stringify(custom.body));
  }

  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const from = (page - 1) * perPage;
  const data = Array.from({ length: Math.max(0, Math.min(perPage, total - from)) }, (_, i) => ({ id: from + i + 1 }));
  const next = page < lastPage ? `http://localhost/next?page=${page + 1}` : null;
  /** @type {any} */
  let body = { data, links: { next }, meta: { current_page: page, last_page: lastPage, per_page: perPage, total } };
  if (mode === "links-only") body = { data, links: { next } };
  if (mode === "bare") body = { data };

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();
const baseUrl = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/v1`;

function setup(options = {}) {
  seen = [];
  total = options.total ?? 25;
  mode = options.mode ?? "full";
  override = undefined;
}

const hapio = createHapioClient({ token: "test-token", baseUrl });

/** @param {AsyncIterable<any>} iterable */
async function collect(iterable) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

const pagesRequested = () => seen.map((r) => Number(new URL(r.url, "http://localhost").searchParams.get("page")));

describe("paginate()", () => {
  it("yields every item, one page at a time and in order", async () => {
    setup({ total: 25 });
    const items = await collect(hapio.paginate("getBookings", { query: { per_page: 10 } }));
    assert.deepEqual(items.map((i) => i.id), Array.from({ length: 25 }, (_, i) => i + 1));
    assert.deepEqual(pagesRequested(), [1, 2, 3]);
  });

  it("does not request a page past meta.last_page", async () => {
    setup({ total: 20 });
    await collect(hapio.paginate("getBookings", { query: { per_page: 10 } }));
    assert.equal(seen.length, 2);
  });

  it("uses the API's default page size when per_page is not given", async () => {
    setup({ total: 120 });
    const items = await collect(hapio.paginate("getBookings"));
    assert.equal(items.length, 120);
    assert.equal(seen.length, 2);
    assert.ok(!seen[0].url.includes("per_page"));
  });

  it("handles a single page and an empty collection", async () => {
    setup({ total: 3 });
    assert.equal((await collect(hapio.paginate("getBookings"))).length, 3);
    assert.equal(seen.length, 1);

    setup({ total: 0 });
    assert.deepEqual(await collect(hapio.paginate("getBookings")), []);
    assert.equal(seen.length, 1);
  });

  it("starts at query.page", async () => {
    setup({ total: 30 });
    const items = await collect(hapio.paginate("getBookings", { query: { per_page: 10, page: 2 } }));
    assert.deepEqual(items.map((i) => i.id), Array.from({ length: 20 }, (_, i) => i + 11));
    assert.deepEqual(pagesRequested(), [2, 3]);
  });

  it("sends path params, other query params, headers and the token on every page", async () => {
    setup({ total: 6 });
    await collect(
      hapio.paginate("getResourceScheduleBlocks", {
        path: { resource: "res-1" },
        query: { per_page: 2, location: "loc-1", "starts_at[gte]": new Date("2026-02-01T00:00:00Z") },
        headers: { "X-App": "demo" },
      }),
    );
    assert.equal(seen.length, 3);
    for (const [index, request] of seen.entries()) {
      const url = new URL(request.url, "http://localhost");
      assert.equal(url.pathname, "/v1/resources/res-1/schedule-blocks");
      assert.equal(url.searchParams.get("page"), String(index + 1));
      assert.equal(url.searchParams.get("location"), "loc-1");
      assert.equal(url.searchParams.get("starts_at[gte]"), "2026-02-01T00:00:00+00:00");
      assert.equal(request.headers["x-app"], "demo");
      assert.equal(request.headers.authorization, "Bearer test-token");
    }
  });

  it("does not modify the arguments it is given", async () => {
    setup({ total: 5 });
    const args = { query: { per_page: 2 }, headers: { "X-App": "demo" } };
    await collect(hapio.paginate("getBookings", args));
    assert.deepEqual(args, { query: { per_page: 2 }, headers: { "X-App": "demo" } });
  });

  it("stops requesting pages when the loop is left early", async () => {
    setup({ total: 100 });
    for await (const item of hapio.paginate("getBookings", { query: { per_page: 10 } })) {
      assert.equal(item.id, 1);
      break;
    }
    assert.equal(seen.length, 1);
  });

  it("falls back to links.next when there is no meta", async () => {
    setup({ total: 25, mode: "links-only" });
    const items = await collect(hapio.paginate("getBookings", { query: { per_page: 10 } }));
    assert.equal(items.length, 25);
    assert.equal(seen.length, 3);
  });

  it("refuses to guess when there is no pagination information at all", async () => {
    setup({ total: 25, mode: "bare" });
    const items = [];
    await assert.rejects(
      async () => {
        for await (const item of hapio.paginate("getBookings", { query: { per_page: 10 } })) items.push(item);
      },
      /no pagination information/,
    );
    // Nothing is yielded from a response that can't be paginated, and no further pages are requested.
    assert.equal(items.length, 0);
    assert.equal(seen.length, 1);
  });

  it("stops at an empty page even when the API claims there is a next one", async () => {
    setup({ total: 25 });
    override = () => ({ status: 200, body: { data: [], links: { next: "http://localhost/next" }, meta: { last_page: 99 } } });
    assert.deepEqual(await collect(hapio.paginate("getBookings")), []);
    assert.equal(seen.length, 1);
  });

  it("throws at once for operations that are unknown or not paginated, before sending anything", () => {
    setup();
    assert.throws(() => hapio.paginate(/** @type {any} */ ("getNothing")), /Unknown operation "getNothing"/);
    assert.throws(
      () => hapio.paginate(/** @type {any} */ ("getBooking"), { path: { booking: "x" } }),
      /"getBooking" is not a paginated operation/,
    );
    assert.throws(() => hapio.paginate(/** @type {any} */ ("toString")), /Unknown operation/);
    assert.equal(seen.length, 0);
  });

  it("rejects an invalid start page when paginate() is called", () => {
    setup();
    for (const page of [0, -1, 1.5, "2", Number.NaN]) {
      assert.throws(
        () => hapio.paginate("getBookings", { query: { page: /** @type {any} */ (page) } }),
        /start page must be a positive integer/,
      );
    }
    assert.equal(seen.length, 0);
  });

  it("does not request anything until the first item is asked for", async () => {
    setup({ total: 3 });
    const iterator = hapio.paginate("getBookings");
    assert.equal(seen.length, 0);
    await iterator.next();
    assert.equal(seen.length, 1);
  });

  it("ignores a non-numeric last_page and uses links.next, so it cannot loop forever", async () => {
    setup({ total: 25 });
    override = (page) => ({
      status: 200,
      body: { data: page <= 3 ? [{ id: page }] : [], links: { next: page < 3 ? "http://localhost/next" : null }, meta: { last_page: Number.NaN } },
    });
    // JSON turns NaN into null, so last_page arrives as null: still not a finite number.
    const items = await collect(hapio.paginate("getBookings"));
    assert.equal(items.length, 3);
    assert.equal(seen.length, 3);
  });

  it("throws when last_page is unusable and there are no links either", async () => {
    setup();
    override = () => ({ status: 200, body: { data: [{ id: 1 }], meta: { last_page: "many" } } });
    await assert.rejects(() => collect(hapio.paginate("getBookings")), /no pagination information/);
  });

  it("throws when the response has no data array", async () => {
    setup();
    override = () => ({ status: 200, body: { message: "hello" } });
    await assert.rejects(() => collect(hapio.paginate("getBookings")), /did not return a "data" array/);
  });

  it("yields the items it already has, then throws, when a later page fails", async () => {
    setup({ total: 25 });
    override = (page) => (page === 2 ? { status: 500, body: { message: "boom" } } : undefined);
    const items = [];
    await assert.rejects(
      async () => {
        for await (const item of hapio.paginate("getBookings", { query: { per_page: 10 } })) items.push(item);
      },
      (err) => err instanceof HapioError && err.status === 500,
    );
    assert.equal(items.length, 10);
  });

  it("works with the retry option when a page is rate limited", async () => {
    setup({ total: 25 });
    let limited = false;
    override = (page) => {
      if (page === 2 && !limited) {
        limited = true;
        return { status: 429, body: { message: "Too Many Attempts." }, headers: { "retry-after": "0" } };
      }
      return undefined;
    };
    const patient = createHapioClient({ token: "test-token", baseUrl, retry: true });
    const items = await collect(patient.paginate("getBookings", { query: { per_page: 10 } }));
    assert.equal(items.length, 25);
    assert.deepEqual(pagesRequested(), [1, 2, 2, 3]);
  });

  it("stops when the signal is aborted between pages", async () => {
    setup({ total: 100 });
    const controller = new AbortController();
    const items = [];
    await assert.rejects(
      async () => {
        for await (const item of hapio.paginate("getBookings", { query: { per_page: 10 }, signal: controller.signal })) {
          items.push(item);
          if (items.length === 10) controller.abort(new Error("stop"));
        }
      },
      /stop/,
    );
    assert.equal(items.length, 10);
    assert.equal(seen.length, 1);
  });

  it("is available for exactly the operations that have a page parameter", () => {
    const withPage = Object.entries(operations)
      .filter(([, op]) => (op.params?.query ?? []).includes("page"))
      .map(([id]) => id)
      .sort();
    assert.equal(withPage.length, 11);
    assert.deepEqual(withPage, [
      "getBookingGroups",
      "getBookings",
      "getLocations",
      "getResourceFullyBooked",
      "getResourceRecurringScheduleBlocks",
      "getResourceRecurringSchedules",
      "getResourceSchedule",
      "getResourceScheduleBlocks",
      "getResources",
      "getServiceBookableSlots",
      "getServices",
    ]);
  });
});
