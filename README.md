# Hapio SDK for JavaScript

The Hapio SDK for JavaScript lets you call the [Hapio API](https://hapio.io/api/) for bookings and scheduling from Node.js, browsers, and other JavaScript runtimes.

It is a thin, typed client generated from Hapio’s OpenAPI specification. You get one method per API operation — for example `getBookings()`, `postBooking()`, and `getServiceBookableSlots()`.

## Requirements

- **Node.js 20.19+ or 22.12+** for server-side usage (built-in `fetch`)
- Any environment with `fetch` and ES modules (including modern browsers with a bundler)

The package is an ES module, so use `import`. In a CommonJS project, `require('hapio-sdk')` also works on the supported Node.js versions. On older versions it fails with `ERR_REQUIRE_ESM`, so use `await import('hapio-sdk')` there.

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
import { createHapioClient } from 'hapio-sdk';

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
    token: 'your-api-token',
    baseUrl: 'https://eu-central-1.hapio.net/v1', // optional, this is the default
    headers: { 'X-Custom-Header': 'value' }, // optional default headers
    fetch, // optional fetch implementation
});
```

### Local API

When running Hapio locally:

```js
const hapio = createHapioClient({
    token: process.env.HAPIO_TOKEN,
    baseUrl: 'http://localhost:8080/v1',
});
```

## Calling the API

Every OpenAPI `operationId` becomes a method on the client.

Each method accepts one optional argument object:

| Key       | Purpose                                                                                                         |
| --------- | --------------------------------------------------------------------------------------------------------------- |
| `path`    | Path parameters, e.g. `{ booking: "uuid" }` (use quotes for hyphenated names such as `{ 'booking-group': id }`) |
| `query`   | Query parameters                                                                                                |
| `body`    | JSON request body for POST, PUT, and PATCH                                                                      |
| `headers` | Extra headers for this request                                                                                  |
| `signal`  | `AbortSignal` for timeouts and cancellation                                                                     |

### Examples

```js
// GET /bookings/{booking}
const booking = await hapio.getBooking({
    path: { booking: '41bf45bd-67eb-4b30-af4c-a96197fde8e3' },
});

// POST /bookings
const created = await hapio.postBooking({
    body: {
        service_id: '…',
        location_id: '…',
        resource_id: '…', // optional — Hapio can select a resource automatically
        starts_at: '2026-02-01T10:00:00+00:00',
        ends_at: '2026-02-01T10:30:00+00:00',
        is_temporary: false,
        metadata: { source: 'my-app' },
    },
});

// GET /services/{service}/bookable-slots
const slots = await hapio.getServiceBookableSlots({
    path: { service: '…' },
    query: {
        location: '…',
        from: '2026-02-01T00:00:00+00:00',
        to: '2026-02-07T00:00:00+00:00',
    },
});
```

Most list endpoints are paginated and return `{ data, links, meta }`. `per_page` defaults to 100 and is limited to 100 (see [Pagination](#pagination) to walk through all pages). The association endpoints `getResourceServices()` and `getServiceResources()` return plain arrays.

### Filtering

Some list endpoints use enum filters instead of booleans. For example, `canceled` and `temporary` accept `exclude`, `include`, or `only`:

```js
const canceled = await hapio.getBookings({
    query: { page: 1, per_page: 50, canceled: 'only' },
});
```

Bracket-style query keys are passed as plain object keys:

```js
const bookings = await hapio.getBookings({
    query: {
        'starts_at[gte]': '2026-02-01T00:00:00+00:00',
        'starts_at[lte]': '2026-03-01T00:00:00+00:00',
    },
});
```

Sort with `<property>.asc` or `<property>.desc`, and combine sorts with commas:

```js
const latest = await hapio.getBookings({
    query: { sort: 'starts_at.desc,created_at.asc' },
});
```

### Pagination

`paginate()` walks every page of a paginated operation and yields the items one by one:

```js
for await (const booking of hapio.paginate('getBookings', {
    query: { canceled: 'exclude', 'starts_at[gte]': '2026-02-01T00:00:00+00:00' },
})) {
    console.log(booking.id);
}
```

- It takes the same arguments as the operation and sends one request per page, starting at `query.page` (default 1) and stopping after the last page. Set `query.per_page` (1–100, default 100) to change the page size.
- Breaking out of the loop stops requesting more pages, and the `signal` you pass also cancels the iteration.
- Your arguments are not modified.
- It works for the operations that return `{ data, links, meta }`: `getBookings`, `getBookingGroups`, `getLocations`, `getResources`, `getServices`, `getResourceScheduleBlocks`, `getResourceRecurringSchedules`, `getResourceRecurringScheduleBlocks`, `getResourceSchedule`, `getResourceFullyBooked` and `getServiceBookableSlots`. TypeScript only accepts these, and types each item. Other operations throw a `TypeError`.
- To collect everything into an array, push in the loop (`Array.fromAsync` needs Node.js 22):

```js
const bookings = [];
for await (const booking of hapio.paginate('getBookings')) bookings.push(booking);
```

Every page is a request, and the API allows a limited number per window. For large collections, use the [`retry`](#rate-limits-and-retries) option so a `429` waits and continues instead of ending the loop.

### Prices and metadata

- `price` is a string with exactly three decimals, for example `'149.000'`. Other formats such as `'149'` or `'149.00'` are rejected.
- `metadata` and `protected_metadata` accept any JSON object. An empty object (`{}`) is returned by the API as `[]`, and key order is not preserved.

### Lower-level access

The client also exposes:

- `hapio.request(operation, args)` — call any entry from `hapio.operations`
- `hapio.operations` — the generated operation map
- `hapio.baseUrl` — the resolved base URL

## Error handling

Non-2xx responses throw `HapioError` with the HTTP status, parsed response body, and response headers. The error message includes the API's own message when there is one, for example `Hapio API error (404): The booking was not found.`

```js
import { createHapioClient, HapioError } from 'hapio-sdk';

const hapio = createHapioClient({ token: process.env.HAPIO_TOKEN });

try {
    await hapio.getBooking({ path: { booking: '…' } });
} catch (err) {
    if (err instanceof HapioError) {
        console.error(err.status);
        console.dir(err.data);
    } else {
        throw err; // network errors, missing path params, etc.
    }
}
```

Validation errors (`422`) list the problems per field in `err.data.errors`.

Successful `DELETE` responses that return `204 No Content` resolve to `undefined`.

### Rate limits and retries

The API rate-limits requests and answers with `429` once the limit is reached. Every response carries `x-ratelimit-limit` and `x-ratelimit-remaining`, and a `429` also has `retry-after` (seconds until the window resets, up to about a minute).

Retrying is off by default. Turn it on with the `retry` option and the client waits for `Retry-After` and sends the request again:

```js
const hapio = createHapioClient({
    token: process.env.HAPIO_TOKEN,
    retry: true, // or { attempts: 3, baseDelayMs: 1000, maxDelayMs: 60000 }
});
```

- Only `429` responses are retried. A `429` means the request was not processed, so this is safe for `POST`, `PUT`, `PATCH` and `DELETE` too.
- `attempts` is the number of retries after the first attempt (default 3). Without a usable `Retry-After` header the wait starts at `baseDelayMs` and doubles on each retry.
- If `Retry-After` is longer than `maxDelayMs` (default 60000), the client does not wait and throws the `429` straight away.
- The `signal` you pass also cancels a pending wait.
- When the attempts run out, the last `429` is thrown as a `HapioError` as usual. The headers are on the error either way:

```js
try {
    await hapio.getBookings();
} catch (err) {
    if (err instanceof HapioError && err.status === 429) {
        console.log(err.headers['retry-after'], err.headers['x-ratelimit-remaining']);
    }
}
```

Waiting up to a minute is normal for a burst of requests, so use a timeout (below) if your caller can't wait that long.

### Timeouts

There is no built-in timeout. Pass an `AbortSignal` to set one. The call then rejects with the signal's reason (a `TimeoutError`, not a `HapioError`):

```js
await hapio.getBookings({ signal: AbortSignal.timeout(10_000) });
```

## Date and time values

The API expects ISO 8601 timestamps in the form `2026-02-01T10:00:00+00:00`. It **rejects** `Date.prototype.toISOString()` output (`2026-02-01T10:00:00.000Z`) with a `422`.

`Date` objects you pass in `query` or `body` are formatted for you, in UTC without milliseconds. Strings are sent exactly as you give them. You can also format a date yourself:

```js
import { formatTimestamp } from 'hapio-sdk';

formatTimestamp(new Date('2026-02-01T10:00:00.789Z')); // '2026-02-01T10:00:00+00:00'

const bookings = await hapio.getBookings({
    query: { 'starts_at[gte]': formatTimestamp(new Date()) },
});
```

In TypeScript, request timestamps (query parameters such as `from`, `to` and `starts_at[gte]`, and body fields such as `starts_at` and `ends_at`) accept a `Date` as well as a string. Fields that are plain dates (`YYYY-MM-DD`, such as `start_date`) take strings only, and so do responses. Timestamps in responses use the project's local UTC offset (for example `+02:00`), so don't assume UTC when parsing them.

## Resources

- [Hapio API documentation](https://docs.hapio.io/)
- [Hapio portal](https://hapio.app)
- [PHP SDK](https://github.com/Hapio-Booking-and-Scheduling-API/hapio-sdk-php)
- [Source repository](https://github.com/Hapio-Booking-and-Scheduling-API/hapio-sdk-javascript)
- [Issues](https://github.com/Hapio-Booking-and-Scheduling-API/hapio-sdk-javascript/issues)

## Development

This repository contains the hand-written client (`src/lib/`) and committed generated output (`src/generated/`).

The OpenAPI spec is a **maintainer-only** build input and is not published to npm. To regenerate the client when the API changes:

1. Get `Hapio-API.v1.yaml` from the API maintainers and place it in the repository root (it is git-ignored), in a parent directory, or point to it with `HAPIO_SPEC=/path/to/Hapio-API.v1.yaml`
2. Regenerate, test, and commit the updated files
3. Bump the package version and publish

```bash
npm install
npm run generate
npm test
npm run test:types
npm run check
```

### Live test

`npm run test:live` runs every operation against the real API, creating and deleting its own data. It is not part of `npm test` or CI. It needs a token for a **dedicated, empty test project**, and it refuses to run if the project already contains locations, resources, services, bookings or booking groups:

```bash
HAPIO_TOKEN=<token of an empty test project> npm run test:live
```

It makes more requests than the API allows per minute, so it relies on the `retry` option and can take a minute or more. It fails if a new operation is added to the spec without a step that exercises it.

`npm publish` runs `prepublishOnly` (tests, type tests and `npm run check`) and `prepack`. It does not regenerate from the spec.
