import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { createHapioClient, HapioError } from "../src/index.js";
import { operations } from "../src/generated/operations.js";

/**
 * @param {Record<string, string>} map
 */
function mockHeaders(map = {}) {
  const normalized = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    get(name) {
      return normalized[String(name).toLowerCase()] ?? null;
    },
    entries() {
      return Object.entries(normalized);
    },
  };
}

/**
 * @param {unknown} data
 * @param {{ status?: number, headers?: Record<string, string> }} [options]
 */
function jsonResponse(data, { status = 200, headers = {} } = {}) {
  const body = JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: mockHeaders({ "content-type": "application/json", ...headers }),
    json: async () => data,
    text: async () => body,
  };
}

/**
 * @param {string} text
 * @param {{ status?: number }} [options]
 */
function textResponse(text, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: mockHeaders({ "content-type": "text/plain" }),
    json: async () => {
      throw new SyntaxError("not json");
    },
    text: async () => text,
  };
}

/**
 * @param {(url: string, init: RequestInit) => Response | Promise<Response>} handler
 */
function mockFetch(handler) {
  return /** @type {typeof fetch} */ (async (url, init) => handler(String(url), init ?? {}));
}

describe("createHapioClient", () => {
  /** @type {typeof fetch | undefined} */
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("exposes generated operation methods", () => {
    const hapio = createHapioClient({
      token: "test-token",
      fetch: mockFetch(() => jsonResponse({})),
    });

    assert.equal(typeof hapio.getBookings, "function");
    assert.equal(typeof hapio.postBooking, "function");
    assert.equal(Object.keys(operations).length, 60);
  });

  it("requires a fetch implementation", () => {
    globalThis.fetch = undefined;

    assert.throws(
      () => createHapioClient({ token: "test-token" }),
      /No fetch\(\) implementation available/,
    );
  });

  it("uses a custom baseUrl", async () => {
    const hapio = createHapioClient({
      token: "test-token",
      baseUrl: "http://localhost:8080/v1/",
      fetch: mockFetch((url) => {
        assert.equal(url, "http://localhost:8080/v1/project");
        return jsonResponse({ id: "project-1" });
      }),
    });

    const project = await hapio.getYourProject();
    assert.equal(project.id, "project-1");
    assert.equal(hapio.baseUrl, "http://localhost:8080/v1/");
  });

  it("sends Bearer authorization by default", async () => {
    const hapio = createHapioClient({
      token: "secret-token",
      fetch: mockFetch((_url, init) => {
        assert.equal(init.headers?.Authorization, "Bearer secret-token");
        return jsonResponse([]);
      }),
    });

    await hapio.getBookings();
  });

  it("does not override a custom Authorization header", async () => {
    const hapio = createHapioClient({
      token: "secret-token",
      fetch: mockFetch((_url, init) => {
        assert.equal(init.headers?.Authorization, "Bearer custom");
        return jsonResponse([]);
      }),
    });

    await hapio.getBookings({ headers: { Authorization: "Bearer custom" } });
  });

  it("applies default client headers", async () => {
    const hapio = createHapioClient({
      token: "secret-token",
      headers: { "X-App": "demo" },
      fetch: mockFetch((_url, init) => {
        assert.equal(init.headers?.["X-App"], "demo");
        return jsonResponse([]);
      }),
    });

    await hapio.getBookings();
  });

  it("builds path and query parameters", async () => {
    const bookingId = "41bf45bd-67eb-4b30-af4c-a96197fde8e3";
    const hapio = createHapioClient({
      token: "secret-token",
      fetch: mockFetch((url) => {
        assert.equal(
          url,
          "https://eu-central-1.hapio.net/v1/bookings/" +
            bookingId +
            "?page=2&per_page=25&starts_at%5Bgte%5D=2026-02-01T00%3A00%3A00%2B00%3A00",
        );
        return jsonResponse({ id: bookingId });
      }),
    });

    const booking = await hapio.getBooking({
      path: { booking: bookingId },
      query: {
        page: 2,
        per_page: 25,
        "starts_at[gte]": "2026-02-01T00:00:00+00:00",
      },
    });

    assert.equal(booking.id, bookingId);
  });

  it("JSON-encodes POST bodies", async () => {
    const hapio = createHapioClient({
      token: "secret-token",
      fetch: mockFetch((_url, init) => {
        assert.equal(init.method, "POST");
        assert.equal(init.headers?.["Content-Type"], "application/json");
        assert.equal(init.headers?.Accept, "application/json");
        assert.deepEqual(JSON.parse(String(init.body)), {
          service_id: "svc-1",
          location_id: "loc-1",
          starts_at: "2026-02-01T10:00:00+00:00",
          ends_at: "2026-02-01T10:30:00+00:00",
        });
        return jsonResponse({ id: "booking-1" }, { status: 201 });
      }),
    });

    const created = await hapio.postBooking({
      body: {
        service_id: "svc-1",
        location_id: "loc-1",
        starts_at: "2026-02-01T10:00:00+00:00",
        ends_at: "2026-02-01T10:30:00+00:00",
      },
    });

    assert.equal(created.id, "booking-1");
  });

  it("returns undefined for 204 responses", async () => {
    const hapio = createHapioClient({
      token: "secret-token",
      fetch: mockFetch(() => ({
        ok: true,
        status: 204,
        headers: mockHeaders(),
        json: async () => {
          throw new Error("should not parse json");
        },
        text: async () => "",
      })),
    });

    const result = await hapio.deleteBooking({
      path: { booking: "41bf45bd-67eb-4b30-af4c-a96197fde8e3" },
    });

    assert.equal(result, undefined);
  });

  it("throws HapioError for non-2xx JSON responses", async () => {
    const hapio = createHapioClient({
      token: "secret-token",
      fetch: mockFetch(() =>
        jsonResponse({ message: "Not found" }, { status: 404, headers: { "x-request-id": "req-1" } }),
      ),
    });

    try {
      await hapio.getBooking({
        path: { booking: "missing-id" },
      });
      assert.fail("expected HapioError");
    } catch (err) {
      assert.ok(err instanceof HapioError);
      assert.equal(err.status, 404);
      assert.deepEqual(err.data, { message: "Not found" });
      assert.equal(err.headers["x-request-id"], "req-1");
    }
  });

  it("throws when a required path param is missing", async () => {
    const hapio = createHapioClient({
      token: "secret-token",
      fetch: mockFetch(() => jsonResponse({})),
    });

    await assert.rejects(
      () => hapio.getBooking({ path: {} }),
      /Missing required path param "booking"/,
    );
  });

  it("forwards AbortSignal to fetch", async () => {
    const controller = new AbortController();
    const hapio = createHapioClient({
      token: "secret-token",
      fetch: mockFetch((_url, init) => {
        assert.equal(init.signal, controller.signal);
        return textResponse("ok");
      }),
    });

    await hapio.getBookings({ signal: controller.signal });
  });
});
