import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createHapioClient, formatTimestamp, HapioError } from "../../src/index.js";
import { operations } from "../../src/generated/operations.js";

// Live test: runs every operation against the real Hapio API, creating and deleting its own data.
//
//   HAPIO_TOKEN=<token of an EMPTY test project> npm run test:live
//
// - It is not part of `npm test`, and it is skipped when HAPIO_TOKEN is not set.
// - It refuses to run unless the project has no locations, resources, services, bookings or
//   booking groups, so it can never touch real data. Use a dedicated test project.
// - Everything it creates is deleted again, even when a step fails.
// - It makes roughly 110 requests, more than the API's per-minute limit, so it uses the `retry`
//   option and can take a minute or more.

const token = process.env.HAPIO_TOKEN;

/** @type {Map<string, number>} */
const succeeded = new Map();

/**
 * Wraps the client so that every successful operation call is counted.
 *
 * @param {any} client
 */
function counting(client) {
  return new Proxy(client, {
    get(target, prop) {
      const value = target[prop];
      if (typeof prop === "string" && Object.hasOwn(operations, prop)) {
        return async (/** @type {any[]} */ ...args) => {
          const result = await value(...args);
          succeeded.set(prop, (succeeded.get(prop) ?? 0) + 1);
          return result;
        };
      }
      return value;
    },
  });
}

/** @param {any} client */
async function projectCounts(client) {
  const [locations, resources, services, bookings, groups] = await Promise.all([
    client.getLocations({ query: { per_page: 1 } }),
    client.getResources({ query: { per_page: 1 } }),
    client.getServices({ query: { per_page: 1 } }),
    client.getBookings({ query: { per_page: 1, canceled: "include", temporary: "include" } }),
    client.getBookingGroups({ query: { per_page: 1 } }),
  ]);
  return { locations: locations.meta.total, resources: resources.meta.total, services: services.meta.total, bookings: bookings.meta.total, groups: groups.meta.total };
}

const raw = token ? createHapioClient({ token, retry: true }) : undefined;
/** @type {any} */
const hapio = raw ? counting(raw) : undefined;

let blocked = "";
if (raw) {
  const counts = await projectCounts(raw);
  if (Object.values(counts).some((n) => n > 0)) {
    blocked = `The project is not empty (${JSON.stringify(counts)}). The live test only runs against an empty test project.`;
  }
}

if (blocked) {
  it("refuses to run against a project that has data", () => assert.fail(blocked));
} else {
  describe("live API, full cycle", { skip: raw ? false : "set HAPIO_TOKEN to an empty test project to run the live test", timeout: 900_000 }, () => {
    /** @type {Record<string, any>} */
    const C = {};
    const mk = {
      buffer_time_before: "PT0S",
      buffer_time_after: "PT0S",
      booking_window_start: "PT0S",
      booking_window_end: null,
      cancelation_threshold: "PT0S",
      metadata: null,
      protected_metadata: null,
      enabled: true,
    };
    const UNI = "Åäö 日本語 😀";
    const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

    /**
     * @param {string} name
     * @param {number} status
     * @param {() => Promise<unknown>} fn
     */
    async function expectStatus(name, status, fn) {
      await assert.rejects(fn, (err) => err instanceof HapioError && err.status === status, name);
    }

    after(async () => {
      // Whatever a failed step left behind. The project was empty at the start, so everything
      // in it was created by this test.
      const client = /** @type {any} */ (raw);
      const lists = [
        [async () => (await client.getBookings({ query: { per_page: 100, canceled: "exclude", temporary: "include" } })).data, (/** @type {any} */ x) => client.deleteBooking({ path: { booking: x.id } })],
        [async () => (await client.getBookingGroups({ query: { per_page: 100 } })).data, (/** @type {any} */ x) => client.deleteBookingGroup({ path: { "booking-group": x.id } })],
        [async () => (await client.getServices({ query: { per_page: 100 } })).data, (/** @type {any} */ x) => client.deleteService({ path: { service: x.id } })],
        [async () => (await client.getResources({ query: { per_page: 100 } })).data, (/** @type {any} */ x) => client.deleteResource({ path: { resource: x.id } })],
        [async () => (await client.getLocations({ query: { per_page: 100 } })).data, (/** @type {any} */ x) => client.deleteLocation({ path: { location: x.id } })],
      ];
      for (const [list, remove] of lists) {
        for (const item of await list()) await remove(item).catch(() => {});
      }
    });

    it("starts from an empty project", async () => {
      const project = await hapio.getYourProject();
      assert.ok(project.id);
    });

    it("creates and manages a location", async () => {
      C.loc = await hapio.postLocation({
        body: { name: `sdk ${UNI}`, time_zone: "Europe/Stockholm", resource_selection_strategy: "randomize", enabled: true, metadata: { a: { b: [1, 2] } } },
      });
      assert.equal((await hapio.getLocation({ path: { location: C.loc.id } })).name, `sdk ${UNI}`);
      assert.equal((await hapio.patchLocation({ path: { location: C.loc.id }, body: { name: "sdk loc" } })).name, "sdk loc");
      const put = await hapio.putLocation({
        path: { location: C.loc.id },
        body: { name: "sdk loc put", time_zone: "Europe/Stockholm", resource_selection_strategy: "equalize", enabled: true },
      });
      assert.equal(put.resource_selection_strategy, "equalize");
      assert.equal((await hapio.getLocations()).meta.total, 1);
    });

    it("creates and manages a resource", async () => {
      C.res = await hapio.postResource({ body: { name: "sdk res", max_simultaneous_bookings: 1, enabled: true, protected_metadata: { s: 1 } } });
      assert.equal((await hapio.getResource({ path: { resource: C.res.id } })).protected_metadata?.s, 1);
      assert.equal((await hapio.patchResource({ path: { resource: C.res.id }, body: { name: "sdk res p" } })).name, "sdk res p");
      const put = await hapio.putResource({ path: { resource: C.res.id }, body: { name: "sdk res put", max_simultaneous_bookings: 1, enabled: true } });
      assert.equal(put.name, "sdk res put");
      assert.equal((await hapio.getResources()).meta.total, 1);
    });

    it("creates and manages fixed, flexible and day services", async () => {
      C.svc = await hapio.postService({ body: { name: "sdk fixed", type: "fixed", price: "100.000", duration: "PT30M", bookable_interval: null, ...mk } });
      assert.equal(C.svc.price, "100.000");
      C.flex = await hapio.postService({
        body: { name: "sdk flex", type: "flexible", price: null, min_duration: "PT30M", max_duration: "PT2H", default_duration: "PT1H", duration_step: "PT30M", bookable_interval: null, ...mk },
      });
      C.day = await hapio.postService({
        body: { name: "sdk day", type: "day", price: null, start_time: "08:00:00", end_time: "17:00:00", min_days: 1, max_days: 3, default_days: null, ...mk },
      });
      assert.deepEqual([C.svc.type, C.flex.type, C.day.type], ["fixed", "flexible", "day"]);
      assert.equal((await hapio.patchService({ path: { service: C.svc.id }, body: { name: "sdk fixed p" } })).name, "sdk fixed p");
      const put = await hapio.putService({
        path: { service: C.svc.id },
        body: { name: "sdk fixed put", type: "fixed", price: "120.000", duration: "PT30M", bookable_interval: null, ...mk },
      });
      assert.equal(put.price, "120.000");
      assert.equal((await hapio.getService({ path: { service: C.svc.id } })).name, "sdk fixed put");
      assert.equal((await hapio.getServices()).meta.total, 3);
      await hapio.deleteService({ path: { service: C.day.id } });
      await hapio.deleteService({ path: { service: C.flex.id } });
      assert.equal((await hapio.getServices()).meta.total, 1);
    });

    it("links resources and services from both sides", async () => {
      await hapio.putResourceService({ path: { resource: C.res.id, service: C.svc.id } });
      assert.equal((await hapio.getResourceService({ path: { resource: C.res.id, service: C.svc.id } })).service_id, C.svc.id);
      assert.equal((await hapio.getResourceServices({ path: { resource: C.res.id } })).length, 1);
      assert.equal((await hapio.getServiceResources({ path: { service: C.svc.id } })).length, 1);
      assert.equal((await hapio.getServiceResource({ path: { service: C.svc.id, resource: C.res.id } })).resource_id, C.res.id);
      await hapio.deleteResourceService({ path: { resource: C.res.id, service: C.svc.id } });
      assert.equal((await hapio.getResourceServices({ path: { resource: C.res.id } })).length, 0);
      await hapio.putServiceResource({ path: { service: C.svc.id, resource: C.res.id } });
      assert.equal((await hapio.getResourceServices({ path: { resource: C.res.id } })).length, 1);
    });

    it("manages recurring schedules and their blocks", async () => {
      const rsPath = { resource: C.res.id };
      C.rs = await hapio.postResourceRecurringSchedule({ path: rsPath, body: { location_id: C.loc.id, start_date: "2026-10-01", end_date: null, interval: 1 } });
      C.rsPath = { ...rsPath, "recurring-schedule": C.rs.id };
      assert.equal((await hapio.patchResourceRecurringSchedule({ path: C.rsPath, body: { interval: 1 } })).interval, 1);
      const put = await hapio.putResourceRecurringSchedule({ path: C.rsPath, body: { location_id: C.loc.id, start_date: "2026-10-01", end_date: null, interval: 1 } });
      assert.equal(put.interval, 1);
      assert.equal((await hapio.getResourceRecurringSchedule({ path: C.rsPath })).id, C.rs.id);
      assert.equal((await hapio.getResourceRecurringSchedules({ path: rsPath })).meta.total, 1);

      const blocks = [];
      for (const weekday of weekdays) {
        blocks.push(await hapio.postResourceRecurringScheduleBlock({ path: C.rsPath, body: { weekday, start_time: "08:00:00", end_time: "17:00:00" } }));
      }
      const first = { ...C.rsPath, "schedule-block": blocks[0].id };
      assert.equal((await hapio.getResourceRecurringScheduleBlock({ path: first })).weekday, "monday");
      assert.equal((await hapio.patchResourceRecurringScheduleBlock({ path: first, body: { end_time: "18:00:00" } })).end_time, "18:00:00");
      const putBlock = await hapio.putResourceRecurringScheduleBlock({ path: first, body: { weekday: "monday", start_time: "08:00:00", end_time: "17:00:00" } });
      assert.equal(putBlock.end_time, "17:00:00");
      assert.equal((await hapio.getResourceRecurringScheduleBlocks({ path: C.rsPath })).meta.total, 7);
      assert.equal((await hapio.getResourceRecurringScheduleBlocks({ path: C.rsPath, query: { weekday: "monday" } })).meta.total, 1);
      await hapio.deleteResourceRecurringScheduleBlock({ path: { ...C.rsPath, "schedule-block": blocks[6].id } });
      assert.equal((await hapio.getResourceRecurringScheduleBlocks({ path: C.rsPath })).meta.total, 6);
    });

    it("manages one-off schedule blocks", async () => {
      const rsPath = { resource: C.res.id };
      const block = await hapio.postResourceScheduleBlock({
        path: rsPath,
        body: { location_id: C.loc.id, starts_at: "2026-12-24T08:00:00+00:00", ends_at: "2026-12-24T17:00:00+00:00", is_available: false },
      });
      const path = { ...rsPath, "schedule-block": block.id };
      assert.equal((await hapio.getResourceScheduleBlock({ path })).is_available, false);
      assert.equal((await hapio.patchResourceScheduleBlock({ path, body: { is_available: true } })).is_available, true);
      const put = await hapio.putResourceScheduleBlock({
        path,
        body: { location_id: C.loc.id, starts_at: "2026-12-24T08:00:00+00:00", ends_at: "2026-12-24T12:00:00+00:00", is_available: false },
      });
      assert.equal(put.is_available, false);
      assert.equal((await hapio.getResourceScheduleBlocks({ path: rsPath, query: { location: C.loc.id } })).meta.total, 1);
      await hapio.deleteResourceScheduleBlock({ path });
    });

    it("lists the schedule and bookable slots, with Date objects in the query", async () => {
      const from = new Date();
      from.setUTCDate(from.getUTCDate() + 1);
      from.setUTCHours(0, 0, 0, 0);
      const to = new Date(from.getTime() + 3 * 86_400_000);
      C.from = from;
      C.to = to;
      const win = { location: C.loc.id, from, to };
      assert.ok((await hapio.getResourceSchedule({ path: { resource: C.res.id }, query: win })).data.length >= 3);
      assert.equal((await hapio.getResourceFullyBooked({ path: { resource: C.res.id }, query: win })).data.length, 0);
      C.slots = (await hapio.getServiceBookableSlots({ path: { service: C.svc.id }, query: { ...win, per_page: 100 } })).data;
      assert.ok(C.slots.length > 10, `only ${C.slots.length} slots`);
    });

    /** @param {any} slot @param {Record<string, unknown>=} extra */
    const bookingBody = (slot, extra = {}) => ({
      resource_id: C.res.id,
      service_id: C.svc.id,
      location_id: C.loc.id,
      starts_at: slot.starts_at,
      ends_at: slot.ends_at,
      is_temporary: false,
      ...extra,
    });

    it("creates, reads, updates, filters and lists bookings", async () => {
      const slots = C.slots;
      C.bk = await hapio.postBooking({
        body: { service_id: C.svc.id, location_id: C.loc.id, starts_at: slots[0].starts_at, ends_at: slots[0].ends_at, is_temporary: false, metadata: { source: "sdk-test", "å": "ö" } },
      });
      assert.equal(C.bk.resource?.id, C.res.id, "a resource is selected automatically");
      assert.equal((await hapio.getBooking({ path: { booking: C.bk.id } })).metadata?.source, "sdk-test");
      const patched = await hapio.patchBooking({ path: { booking: C.bk.id }, body: { metadata: { source: "sdk-test", patched: true } } });
      assert.equal(patched.metadata.patched, true);
      assert.equal((await hapio.getBookings({ query: { "metadata[patched][eq]": "true" } })).meta.total, 1);

      const put = await hapio.putBooking({ path: { booking: C.bk.id }, body: bookingBody(slots[1], { is_temporary: true, price: "50.000" }) });
      assert.equal(put.price, "50.000");
      // Temporary bookings are hidden unless asked for.
      assert.equal((await hapio.getBookings({ query: { location: C.loc.id } })).meta.total, 0);
      assert.equal((await hapio.getBookings({ query: { location: C.loc.id, temporary: "include" } })).meta.total, 1);
      assert.equal((await hapio.getBookings({ query: { location: C.loc.id, temporary: "only" } })).meta.total, 1);
      assert.equal((await hapio.patchBooking({ path: { booking: C.bk.id }, body: { is_temporary: false } })).is_temporary, false);

      const inWindow = await hapio.getBookings({ query: { location: C.loc.id, "starts_at[gte]": C.from, "starts_at[lt]": C.to } });
      assert.equal(inWindow.meta.total, 1);
      assert.equal((await hapio.getBookings({ query: { sort: "starts_at.desc" } })).data.length, 1);
    });

    it("rejects overlaps, closed schedules, bad dates and unknown bookings", async () => {
      const slots = C.slots;
      await expectStatus("overlap", 422, () => hapio.postBooking({ body: bookingBody(slots[1]) }));
      await expectStatus("outside the schedule", 422, () =>
        hapio.postBooking({
          body: bookingBody({}, { starts_at: formatTimestamp(new Date(C.from.getTime() + 20 * 3_600_000)), ends_at: formatTimestamp(new Date(C.from.getTime() + 21 * 3_600_000)) }),
        }),
      );
      await expectStatus("toISOString() format", 422, () =>
        hapio.postBooking({ body: bookingBody(slots[3], { ends_at: new Date(slots[3].ends_at).toISOString() }) }),
      );
      await expectStatus("unknown booking", 404, () => hapio.getBooking({ path: { booking: "nope" } }));
    });

    it("lets only one of several parallel bookings win a slot", async () => {
      const slots = C.slots;
      const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => hapio.postBooking({ body: bookingBody(slots[5]) })));
      const winners = attempts.filter((a) => a.status === "fulfilled");
      assert.equal(winners.length, 1);
      C.raceBooking = /** @type {PromiseFulfilledResult<any>} */ (winners[0]).value;
    });

    it("creates a booking from Date objects in the body", async () => {
      const slot = C.slots[10];
      const booking = await hapio.postBooking({
        body: { ...bookingBody(slot), starts_at: new Date(slot.starts_at), ends_at: new Date(slot.ends_at) },
      });
      assert.equal(new Date(booking.starts_at).getTime(), new Date(slot.starts_at).getTime());
      await hapio.deleteBooking({ path: { booking: booking.id } });
    });

    it("walks through bookings with paginate()", async () => {
      /** @type {string[]} */
      const ids = [];
      for await (const booking of hapio.paginate("getBookings", { query: { per_page: 1 } })) ids.push(booking.id);
      assert.equal(ids.length, 2, "the first booking and the race winner");
      assert.equal(new Set(ids).size, 2);
    });

    it("manages booking groups", async () => {
      const slots = C.slots;
      const group = await hapio.postBookingGroup({
        body: { bookings: [{ resource_id: C.res.id, service_id: C.svc.id, location_id: C.loc.id, starts_at: slots[7].starts_at, ends_at: slots[7].ends_at, is_temporary: false }], metadata: { g: 1 } },
      });
      const path = { "booking-group": group.id };
      assert.equal((await hapio.getBookingGroup({ path })).bookings.length, 1);
      assert.equal((await hapio.patchBookingGroup({ path, body: { metadata: { g: 2 } } })).metadata.g, 2);
      const put = await hapio.putBookingGroup({
        path,
        body: {
          bookings: [{ id: group.bookings[0].id, resource_id: C.res.id, service_id: C.svc.id, location_id: C.loc.id, starts_at: slots[8].starts_at, ends_at: slots[8].ends_at, is_temporary: false }],
          metadata: { g: 3 },
        },
      });
      assert.equal(put.metadata.g, 3);
      assert.equal((await hapio.getBookingGroups()).meta.total, 1);
      await hapio.deleteBookingGroup({ path });
      assert.equal((await hapio.getBookingGroups()).meta.total, 0);
    });

    it("deletes everything it created", async () => {
      await hapio.deleteBooking({ path: { booking: C.bk.id } });
      await expectStatus("deleted booking", 404, () => hapio.getBooking({ path: { booking: C.bk.id } }));
      await hapio.deleteBooking({ path: { booking: C.raceBooking.id } });
      assert.equal((await hapio.getBookings({ query: { canceled: "include", temporary: "include" } })).meta.total, 0);

      await hapio.deleteServiceResource({ path: { service: C.svc.id, resource: C.res.id } });
      await hapio.deleteResourceRecurringSchedule({ path: C.rsPath });
      await hapio.deleteService({ path: { service: C.svc.id } });
      await hapio.deleteResource({ path: { resource: C.res.id } });
      await hapio.deleteLocation({ path: { location: C.loc.id } });

      assert.deepEqual(await projectCounts(hapio), { locations: 0, resources: 0, services: 0, bookings: 0, groups: 0 });
    });

    it("has exercised every generated operation", () => {
      const missing = Object.keys(operations).filter((id) => !succeeded.has(id));
      assert.deepEqual(missing, [], "add a step for each new operation to this test");
    });
  });
}
