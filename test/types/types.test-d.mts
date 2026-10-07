// Type-level tests. Run with `npm run test:types`.
// Compiled under NodeNext without skipLibCheck, the way strict ESM consumers use the SDK.
// Each @ts-expect-error fails the build if the line below it stops producing an error.
import { createHapioClient, formatTimestamp, HapioError } from "../../src/index.js";
import type { HapioClient, HapioResponse, HapioRetryOptions, OperationId } from "../../src/index.js";

const hapio = createHapioClient({ token: "test-token" });

// Valid calls compile.
const bookings = await hapio.getBookings({ query: { page: 1, per_page: 10 } });
await hapio.getBooking({ path: { booking: "uuid" } });
await hapio.getBookings();

// Responses are typed, not `any`.
const response: HapioResponse<"getBookings"> = bookings;
// @ts-expect-error response is not a number
const notANumber: number = response;

// Query parameters are checked.
// @ts-expect-error page must be a number
await hapio.getBookings({ query: { page: "one" } });

// Operator filters use bracket keys, as in the README.
await hapio.getBookings({
  query: {
    "starts_at[gte]": "2026-02-01T00:00:00+00:00",
    "starts_at[lte]": "2026-03-01T00:00:00+00:00",
  },
});
await hapio.getBookings({ query: { "metadata[status][eq]": "processed" } });
await hapio.getBookings({ query: { "metadata[customer->name][eq]": "John" } });
const dynamicQuery = { page: 1, "created_at[gt]": "2026-02-01T00:00:00+00:00" };
await hapio.getBookings({ query: dynamicQuery });
await hapio.getResources({ query: { "max_simultaneous_bookings[gt]": 5 } });

// Bracket keys keep their value types and only match known filters.
// @ts-expect-error max_simultaneous_bookings filters are numbers
await hapio.getResources({ query: { "max_simultaneous_bookings[gt]": "five" } });
// @ts-expect-error unknown bracket filter key
await hapio.getBookings({ query: { "nope[gte]": "x" } });
// @ts-expect-error unknown plain key next to bracket filters
await hapio.getBookings({ query: { "starts_at[gte]": "x", bogus: 1 } });

// Path parameters are checked.
// @ts-expect-error unknown path param
await hapio.getBooking({ path: { nope: "uuid" } });

// Request bodies are checked.
// @ts-expect-error body must be an object matching the schema
await hapio.postBooking({ body: "not an object" });

// Unknown operations do not exist.
// @ts-expect-error no such operation
hapio.getNothing();

// Public types resolve to something real.
const id: OperationId = "getBookings";
// @ts-expect-error not an operationId
const badId: OperationId = "getNothing";
const client: HapioClient = hapio;

// Errors expose status and data.
try {
  await hapio.getBooking({ path: { booking: "uuid" } });
} catch (err) {
  if (err instanceof HapioError) {
    const status: number = err.status;
    void status;
  }
}

// The README booking example compiles: free-form metadata, and only the spec-required fields.
await hapio.postBooking({
  body: {
    service_id: "…",
    location_id: "…",
    resource_id: "…",
    starts_at: "2026-02-01T10:00:00+00:00",
    ends_at: "2026-02-01T10:30:00+00:00",
    is_temporary: false,
    metadata: { source: "my-app" },
  },
});
await hapio.postBooking({
  body: { service_id: "a", location_id: "b", starts_at: "x", ends_at: "y" },
});
await hapio.patchBooking({ path: { booking: "a" }, body: { metadata: { nested: { list: [1, "two", null] } } } });
await hapio.postBooking({
  // @ts-expect-error metadata must still be an object
  body: { service_id: "a", location_id: "b", starts_at: "x", ends_at: "y", metadata: "text" },
});

// Hyphenated path params and plain-array responses are typed.
await hapio.getBookingGroup({ path: { "booking-group": "uuid" } });
const resourceServices = await hapio.getResourceServices({ path: { resource: "uuid" } });
const serviceCount: number = resourceServices.length;

// formatTimestamp returns a string and only accepts dates.
const formatted: string = formatTimestamp(new Date());
// @ts-expect-error not a date
formatTimestamp("2026-02-01");

// A Date is accepted for timestamp fields in requests (query parameters and bodies, nested too).
await hapio.getBookings({
  query: { from: new Date(), to: new Date(), "starts_at[gte]": new Date(), "created_at[lt]": new Date() },
});
await hapio.postBooking({
  body: { service_id: "a", location_id: "b", starts_at: new Date(), ends_at: new Date(), buffer_starts_at: new Date() },
});
await hapio.putBooking({
  path: { booking: "a" },
  body: { resource_id: "r", service_id: "a", location_id: "b", starts_at: new Date(), ends_at: new Date() },
});
await hapio.postBookingGroup({
  body: { bookings: [{ service_id: "a", location_id: "b", starts_at: new Date(), ends_at: new Date() }] },
});
await hapio.postResourceScheduleBlock({
  path: { resource: "r" },
  body: { location_id: "l", starts_at: new Date(), ends_at: new Date(), is_available: false },
});
await hapio.getServiceBookableSlots({ path: { service: "s" }, query: { location: "l", from: new Date(), to: new Date() } });
await hapio.getResourceSchedule({ path: { resource: "r" }, query: { location: "l", from: new Date(), to: new Date() } });
// Strings are still fine.
await hapio.getBookings({ query: { from: formatTimestamp(new Date()), "starts_at[gte]": "2026-02-01T00:00:00+00:00" } });

// ...but not for anything else.
// @ts-expect-error page is a number, not a timestamp
await hapio.getBookings({ query: { page: new Date() } });
// @ts-expect-error from/to are plain dates (YYYY-MM-DD) on this endpoint, so strings only
await hapio.getResourceRecurringSchedules({ path: { resource: "r" }, query: { from: new Date() } });
await hapio.postResourceRecurringSchedule({
  path: { resource: "r" },
  // @ts-expect-error start_date is a plain date (YYYY-MM-DD), so strings only
  body: { location_id: "l", start_date: new Date(), end_date: null, interval: 1 },
});
await hapio.postBooking({
  // @ts-expect-error resource_id is not a timestamp
  body: { service_id: "a", location_id: "b", starts_at: "x", ends_at: "y", resource_id: new Date() },
});
await hapio.postBooking({
  // @ts-expect-error a number is not a timestamp
  body: { service_id: "a", location_id: "b", starts_at: 1700000000, ends_at: "y" },
});

// Responses keep plain strings, they are not widened to accept Date.
const aBooking = await hapio.getBooking({ path: { booking: "a" } });
const startsAt: string = aBooking.starts_at; // would be `unknown` if the XML media type leaked in
// @ts-expect-error responses are strings, not Dates
const asDate: Date | undefined = aBooking.starts_at;

// The recurring schedule block operations have consistent names.
await hapio.putResourceRecurringScheduleBlock({
  path: { resource: "r", "recurring-schedule": "s", "schedule-block": "b" },
  body: { weekday: "monday", start_time: "08:00:00", end_time: "17:00:00" },
});
await hapio.patchResourceRecurringScheduleBlock({
  path: { resource: "r", "recurring-schedule": "s", "schedule-block": "b" },
  body: { end_time: "18:00:00" },
});
// @ts-expect-error the old, misspelled name no longer exists
hapio.putResourceRecurringScheduleScheduleBlock();

// Retrying on 429 is opt-in, as a flag or with options.
createHapioClient({ token: "t", retry: true });
createHapioClient({ token: "t", retry: { attempts: 5, baseDelayMs: 200, maxDelayMs: 10_000 } });
const retryOptions: HapioRetryOptions = { attempts: 2 };
// @ts-expect-error retry must be a boolean or an options object
createHapioClient({ retry: "yes" });
// @ts-expect-error unknown retry option
createHapioClient({ retry: { attempts: 2, jitter: true } });

void [notANumber, id, badId, client, serviceCount, formatted, startsAt, asDate, retryOptions];
