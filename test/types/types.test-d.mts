// Type-level tests. Run with `npm run test:types`.
// Compiled under NodeNext without skipLibCheck, the way strict ESM consumers use the SDK.
// Each @ts-expect-error fails the build if the line below it stops producing an error.
import { createHapioClient, HapioError } from "../../src/index.js";
import type { HapioClient, HapioResponse, OperationId } from "../../src/index.js";

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

void [notANumber, id, badId, client];
