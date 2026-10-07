import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import { createHapioClient, formatTimestamp, HapioError } from "../src/index.js";

// These tests talk to a real local HTTP server through the real fetch(), so they cover behaviour the
// fake Response objects in sdk.test.js cannot: header casing, content types, and body parsing.

/** @type {http.Server} */
let server;
/** @type {{ method?: string, url?: string, headers: http.IncomingHttpHeaders, body: string }} */
let last;
/** @type {(req: http.IncomingMessage, res: http.ServerResponse) => void} */
let respond;
let baseUrl = "";

function json(res, status, payload, contentType = "application/json") {
  res.writeHead(status, { "content-type": contentType });
  res.end(JSON.stringify(payload));
}

server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    last = { method: req.method, url: req.url, headers: req.headers, body };
    respond(req, res);
  });
});
respond = (_req, res) => json(res, 200, { ok: true });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();
baseUrl = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/v1`;

function client(options = {}) {
  return createHapioClient({ token: "test-token", baseUrl, ...options });
}

describe("formatTimestamp", () => {
  it("formats UTC without milliseconds and with a +00:00 offset", () => {
    assert.equal(formatTimestamp(new Date("2026-02-01T10:00:00.789Z")), "2026-02-01T10:00:00+00:00");
  });

  it("rejects invalid dates and non-dates", () => {
    assert.throws(() => formatTimestamp(new Date("nope")), TypeError);
    assert.throws(() => formatTimestamp(/** @type {any} */ ("2026-02-01")), TypeError);
  });
});

describe("Date values", () => {
  it("are formatted for the API in query parameters", async () => {
    respond = (_req, res) => json(res, 200, []);
    await client().getBookings({
      query: { from: /** @type {any} */ (new Date("2026-02-01T10:00:00Z")), "starts_at[gte]": "2026-02-01T00:00:00+00:00" },
    });
    const params = new URL(last.url ?? "", baseUrl).searchParams;
    assert.equal(params.get("from"), "2026-02-01T10:00:00+00:00");
    assert.equal(params.get("starts_at[gte]"), "2026-02-01T00:00:00+00:00");
  });

  it("are formatted for the API in JSON bodies, including nested values", async () => {
    respond = (_req, res) => json(res, 201, { id: "booking-1" });
    await client().postBooking({
      body: /** @type {any} */ ({
        service_id: "svc-1",
        location_id: "loc-1",
        starts_at: new Date("2026-02-01T10:00:00Z"),
        ends_at: new Date("2026-02-01T10:30:00.123Z"),
        metadata: { when: new Date("2026-03-01T00:00:00Z") },
      }),
    });
    const sent = JSON.parse(last.body);
    assert.equal(sent.starts_at, "2026-02-01T10:00:00+00:00");
    assert.equal(sent.ends_at, "2026-02-01T10:30:00+00:00");
    assert.equal(sent.metadata.when, "2026-03-01T00:00:00+00:00");
  });

  it("reject invalid dates before sending anything", async () => {
    last = { headers: {}, body: "" };
    await assert.rejects(
      () => client().getBookings({ query: { from: /** @type {any} */ (new Date("nope")) } }),
      TypeError,
    );
    assert.equal(last.url, undefined);
  });
});

describe("arguments and headers", () => {
  it("accepts null args like undefined", async () => {
    respond = (_req, res) => json(res, 200, []);
    await client().getBookings(/** @type {any} */ (null));
    assert.equal(last.url, "/v1/bookings");
  });

  it("sends no Authorization header without a token", async () => {
    respond = (_req, res) => json(res, 200, []);
    await createHapioClient({ baseUrl }).getBookings();
    assert.equal(last.headers.authorization, undefined);
  });

  it("matches header names case-insensitively", async () => {
    respond = (_req, res) => json(res, 200, []);
    await client({ headers: { "x-app": "default", accept: "text/csv" } }).getBookings({
      headers: { "X-App": "call", authorization: "Bearer custom" },
    });
    assert.equal(last.headers["x-app"], "call");
    assert.equal(last.headers.accept, "text/csv");
    assert.equal(last.headers.authorization, "Bearer custom");
  });

  it("does not mutate the header objects it is given", async () => {
    respond = (_req, res) => json(res, 200, []);
    const defaults = { "X-App": "1" };
    const perCall = { "X-Other": "2" };
    const hapio = client({ headers: defaults });
    await hapio.getBookings({ headers: perCall });
    await hapio.getBookings({ headers: perCall });
    assert.deepEqual(defaults, { "X-App": "1" });
    assert.deepEqual(perCall, { "X-Other": "2" });
  });

  it("sends no Content-Type when there is no body", async () => {
    respond = (_req, res) => json(res, 200, []);
    await client().getBookings();
    assert.equal(last.headers["content-type"], undefined);
    assert.equal(last.headers.accept, "application/json");
  });

  it("encodes path parameters", async () => {
    respond = (_req, res) => json(res, 200, {});
    await client().getBooking({ path: { booking: "a/b c" } });
    assert.equal(last.url, "/v1/bookings/a%2Fb%20c");
  });
});

describe("responses", () => {
  it("resolves undefined for a real 204", async () => {
    respond = (_req, res) => {
      res.writeHead(204);
      res.end();
    };
    assert.equal(await client().deleteBooking({ path: { booking: "b" } }), undefined);
  });

  it("parses JSON with a charset", async () => {
    respond = (_req, res) => json(res, 200, { ok: 1 }, "application/json; charset=utf-8");
    assert.deepEqual(await client().getYourProject(), { ok: 1 });
  });

  it("round-trips non-ASCII text", async () => {
    respond = (req, res) => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(last.body);
    };
    const body = { name: "Åäö 日本語 😀", metadata: { "å": "ö" } };
    assert.deepEqual(await client().postLocation({ body: /** @type {any} */ (body) }), body);
  });

  it("resolves null for an empty JSON body", async () => {
    respond = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("");
    };
    assert.equal(await client().getYourProject(), null);
  });

  it("throws on a success response with invalid JSON", async () => {
    respond = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{oops");
    };
    await assert.rejects(
      () => client().getYourProject(),
      (err) => err instanceof HapioError && err.status === 200 && err.data === "{oops",
    );
  });
});

describe("errors", () => {
  it("includes the server message in HapioError.message", async () => {
    respond = (_req, res) => json(res, 404, { message: "The booking was not found." });
    await assert.rejects(
      () => client().getBooking({ path: { booking: "x" } }),
      (err) =>
        err instanceof HapioError &&
        err.status === 404 &&
        err.message === "Hapio API error (404): The booking was not found." &&
        err.data.message === "The booking was not found.",
    );
  });

  it("keeps the generic message when the body has no message", async () => {
    respond = (_req, res) => json(res, 500, { oops: true });
    await assert.rejects(
      () => client().getYourProject(),
      (err) => err instanceof HapioError && err.message === "Hapio API error (500)",
    );
  });

  it("parses application/problem+json error bodies", async () => {
    respond = (_req, res) => json(res, 422, { errors: { a: ["x"] } }, "application/problem+json");
    await assert.rejects(
      () => client().getYourProject(),
      (err) => err instanceof HapioError && err.status === 422 && err.data.errors.a[0] === "x",
    );
  });

  it("keeps non-JSON and malformed error bodies as text", async () => {
    respond = (_req, res) => {
      res.writeHead(502, { "content-type": "text/html" });
      res.end("<h1>Bad gateway</h1>");
    };
    await assert.rejects(
      () => client().getYourProject(),
      (err) => err instanceof HapioError && err.status === 502 && err.data === "<h1>Bad gateway</h1>",
    );

    respond = (_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end("{oops");
    };
    await assert.rejects(
      () => client().getYourProject(),
      (err) => err instanceof HapioError && err.status === 500 && err.data === "{oops",
    );
  });

  it("exposes rate limit headers on a 429", async () => {
    respond = (_req, res) => {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "2", "x-ratelimit-remaining": "0" });
      res.end(JSON.stringify({ message: "Too Many Attempts." }));
    };
    await assert.rejects(
      () => client().getYourProject(),
      (err) => err instanceof HapioError && err.status === 429 && err.headers["retry-after"] === "2",
    );
  });

  it("rejects with the abort reason when the signal fires", async () => {
    respond = (_req, res) => setTimeout(() => json(res, 200, {}), 200);
    await assert.rejects(
      () => client().getYourProject({ signal: AbortSignal.timeout(20) }),
      (err) => err.name === "TimeoutError",
    );
  });

  it("rejects with a network error when nothing is listening", async () => {
    await assert.rejects(() => createHapioClient({ token: "t", baseUrl: "http://127.0.0.1:1/v1" }).getYourProject());
  });
});

describe("retry on 429", () => {
  /**
   * Answers with `limited` 429s (with the given Retry-After), then a 200.
   *
   * @param {number} limited
   * @param {string | undefined} retryAfter
   */
  function limitThenSucceed(limited, retryAfter) {
    const counter = { requests: 0, bodies: /** @type {string[]} */ ([]) };
    respond = (_req, res) => {
      counter.requests++;
      counter.bodies.push(last.body);
      if (counter.requests <= limited) {
        res.writeHead(429, {
          "content-type": "application/json",
          ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
          "x-ratelimit-remaining": "0",
        });
        res.end(JSON.stringify({ message: "Too Many Attempts." }));
      } else {
        json(res, 200, { ok: true });
      }
    };
    return counter;
  }

  it("is off by default", async () => {
    const counter = limitThenSucceed(1, "0");
    await assert.rejects(
      () => client().getYourProject(),
      (err) => err instanceof HapioError && err.status === 429,
    );
    assert.equal(counter.requests, 1);
  });

  it("retries until the request succeeds", async () => {
    const counter = limitThenSucceed(2, "0");
    assert.deepEqual(await client({ retry: true }).getYourProject(), { ok: true });
    assert.equal(counter.requests, 3);
  });

  it("gives up after the configured number of retries and throws the last 429", async () => {
    const counter = limitThenSucceed(10, "0");
    await assert.rejects(
      () => client({ retry: { attempts: 2 } }).getYourProject(),
      (err) =>
        err instanceof HapioError &&
        err.status === 429 &&
        err.message === "Hapio API error (429): Too Many Attempts." &&
        err.headers["x-ratelimit-remaining"] === "0",
    );
    assert.equal(counter.requests, 3);
  });

  it("waits at least as long as Retry-After says", async () => {
    limitThenSucceed(1, "0.2");
    const started = Date.now();
    await client({ retry: true }).getYourProject();
    assert.ok(Date.now() - started >= 190, `waited only ${Date.now() - started}ms`);
  });

  it("accepts an HTTP date in Retry-After", async () => {
    const counter = limitThenSucceed(1, new Date(Date.now() - 5000).toUTCString());
    await client({ retry: true }).getYourProject();
    assert.equal(counter.requests, 2);
  });

  it("backs off exponentially when there is no Retry-After header", async () => {
    const counter = limitThenSucceed(2, undefined);
    const started = Date.now();
    await client({ retry: { attempts: 3, baseDelayMs: 20 } }).getYourProject();
    assert.equal(counter.requests, 3);
    assert.ok(Date.now() - started >= 55, `waited only ${Date.now() - started}ms`); // 20ms + 40ms
  });

  it("does not wait for a Retry-After longer than maxDelayMs, and throws at once", async () => {
    const counter = limitThenSucceed(5, "120");
    const started = Date.now();
    await assert.rejects(
      () => client({ retry: { maxDelayMs: 50 } }).getYourProject(),
      (err) => err instanceof HapioError && err.status === 429,
    );
    assert.equal(counter.requests, 1);
    assert.ok(Date.now() - started < 1000);
  });

  it("sends the same JSON body again on every attempt", async () => {
    const counter = limitThenSucceed(1, "0");
    await client({ retry: true }).postBooking({
      body: /** @type {any} */ ({ service_id: "svc-1", location_id: "loc-1", starts_at: new Date("2026-02-01T10:00:00Z"), ends_at: "x" }),
    });
    assert.equal(counter.requests, 2);
    assert.equal(counter.bodies[0], counter.bodies[1]);
    assert.equal(JSON.parse(counter.bodies[1]).starts_at, "2026-02-01T10:00:00+00:00");
  });

  it("only retries 429, not other errors", async () => {
    let requests = 0;
    respond = (_req, res) => {
      requests++;
      json(res, 500, { message: "boom" });
    };
    await assert.rejects(
      () => client({ retry: true }).getYourProject(),
      (err) => err instanceof HapioError && err.status === 500,
    );
    assert.equal(requests, 1);
  });

  it("stops waiting when the signal is aborted", async () => {
    const counter = limitThenSucceed(5, "5");
    const started = Date.now();
    await assert.rejects(
      () => client({ retry: true }).getYourProject({ signal: AbortSignal.timeout(30) }),
      (err) => err.name === "TimeoutError",
    );
    assert.equal(counter.requests, 1);
    assert.ok(Date.now() - started < 1000);
  });

  it("rejects invalid options when the client is created", () => {
    assert.throws(() => client({ retry: { attempts: -1 } }), /Invalid retry option "attempts"/);
    assert.throws(() => client({ retry: { baseDelayMs: Number.NaN } }), /Invalid retry option "baseDelayMs"/);
  });
});
