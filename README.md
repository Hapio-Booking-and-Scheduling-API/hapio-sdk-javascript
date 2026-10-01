# Hapio SDK for JavaScript

The Hapio SDK for JavaScript lets you call the [Hapio API](https://hapio.io/api/) for bookings and scheduling from Node.js, browsers, and other JavaScript runtimes.

It is a thin, typed client generated from Hapio’s OpenAPI specification. You get one method per API operation — for example `getBookings()`, `postBooking()`, and `getServiceBookableSlots()`.

## Requirements

- **Node.js 18+** for server-side usage (built-in `fetch`)
- Any environment with `fetch` and ES modules (including modern browsers with a bundler)

## Getting started

### 1. Get an API token

Create a project and API token in the [Hapio portal](https://hapio.app). The token is used as a Bearer credential on every request.

### 2. Install

```bash
npm install hapio-sdk
```

The published package ships only the runtime client in `src/`. It does not include the OpenAPI spec.

### 3. Create a client

```js
import { createHapioClient } from "hapio-sdk";

const hapio = createHapioClient({
  token: process.env.HAPIO_TOKEN,
});

const project = await hapio.getYourProject();
const bookings = await hapio.getBookings({
  query: { page: 1, per_page: 10 },
});
```

## Scope

This SDK covers the **project API** — the endpoints available with a project API token:

- bookings and booking groups
- services, resources, and locations
- schedules, bookable slots, and related operations

It currently exposes **60 operations** from OpenAPI spec v1.7.

Admin endpoints (project management, API tokens, webhooks, API request logs) are **not** included.

## TypeScript

The SDK is written in JavaScript but includes TypeScript declarations:

- autocomplete for all generated methods
- typed `path`, `query`, and `body` arguments
- typed success responses from the OpenAPI schema

No `@types` package is required.

## Configuration

```js
const hapio = createHapioClient({
  token: "your-api-token",
  baseUrl: "https://eu-central-1.hapio.net/v1", // optional, this is the default
  headers: { "X-Custom-Header": "value" },       // optional default headers
  fetch,                                          // optional fetch implementation
});
```

### Local API

When running Hapio locally:

```js
const hapio = createHapioClient({
  token: process.env.HAPIO_TOKEN,
  baseUrl: "http://localhost:8080/v1",
});
```

## Calling the API

Every OpenAPI `operationId` becomes a method on the client.

Each method accepts one optional argument object:

| Key | Purpose |
|-----|---------|
| `path` | Path parameters, e.g. `{ booking: "uuid" }` |
| `query` | Query parameters |
| `body` | JSON request body for POST, PUT, and PATCH |
| `headers` | Extra headers for this request |
| `signal` | `AbortSignal` for timeouts and cancellation |

### Examples

```js
// GET /bookings/{booking}
const booking = await hapio.getBooking({
  path: { booking: "41bf45bd-67eb-4b30-af4c-a96197fde8e3" },
});

// POST /bookings
const created = await hapio.postBooking({
  body: {
    service_id: "…",
    location_id: "…",
    resource_id: "…", // optional — Hapio can select a resource automatically
    starts_at: "2026-02-01T10:00:00+00:00",
    ends_at: "2026-02-01T10:30:00+00:00",
    is_temporary: false,
    metadata: { source: "my-app" },
  },
});

// GET /services/{service}/bookable-slots
const slots = await hapio.getServiceBookableSlots({
  path: { service: "…" },
  query: { from: "2026-02-01T00:00:00+00:00", to: "2026-02-07T00:00:00+00:00" },
});
```

### Filtering

Some list endpoints use enum filters instead of booleans. For example, `canceled` and `temporary` accept `exclude`, `include`, or `only`:

```js
const canceled = await hapio.getBookings({
  query: { page: 1, per_page: 50, canceled: "only" },
});
```

Bracket-style query keys are passed as plain object keys:

```js
const bookings = await hapio.getBookings({
  query: {
    "starts_at[gte]": "2026-02-01T00:00:00+00:00",
    "starts_at[lte]": "2026-03-01T00:00:00+00:00",
  },
});
```

### Lower-level access

The client also exposes:

- `hapio.request(operation, args)` — call any entry from `hapio.operations`
- `hapio.operations` — the generated operation map
- `hapio.baseUrl` — the resolved base URL

## Error handling

Non-2xx responses throw `HapioError` with the HTTP status, parsed response body, and response headers.

```js
import { createHapioClient, HapioError } from "hapio-sdk";

const hapio = createHapioClient({ token: process.env.HAPIO_TOKEN });

try {
  await hapio.getBooking({ path: { booking: "…" } });
} catch (err) {
  if (err instanceof HapioError) {
    console.error(err.status);
    console.dir(err.data);
  } else {
    throw err; // network errors, missing path params, etc.
  }
}
```

Successful `DELETE` responses that return `204 No Content` resolve to `undefined`.

## Date and time values

The API expects ISO 8601 timestamps such as `2026-02-01T10:00:00+00:00`.

`Date.prototype.toISOString()` returns UTC with milliseconds (`2026-02-01T10:00:00.000Z`). If the API rejects that format, format timestamps with an explicit offset and without milliseconds.

## Resources

- [Hapio API documentation](https://docs.hapio.io/)
- [Hapio portal](https://hapio.app)
- [PHP SDK](https://github.com/Hapio-Booking-and-Scheduling-API/hapio-sdk-php)
- [Source repository](https://github.com/Hapio-Booking-and-Scheduling-API/hapio-sdk-javascript)
- [Issues](https://github.com/Hapio-Booking-and-Scheduling-API/hapio-sdk-javascript/issues)

## Development

This repository contains the hand-written client (`src/lib/`) and committed generated output (`src/generated/`).

The OpenAPI spec is a **maintainer-only** build input and is not published to npm. To regenerate the client when the API changes:

1. Place `Hapio-API.v1.yaml` where the generator can find it (see `SPEC_CANDIDATES` in `scripts/generate-operations.mjs`)
2. Regenerate, test, and commit the updated files
3. Bump the package version and publish

```bash
npm install
npm run generate
npm test
npm run test:types
npm run check
```

`npm publish` runs `prepack`, which executes `npm run check` to verify that generated code is present. It does not regenerate from the spec.
