import { operations } from "../generated/operations.js";

/**
 * Walks every page of a paginated operation and yields the items one by one.
 *
 * It starts at `args.query.page` (default 1), requests one page at a time, and stops after
 * `meta.last_page` (or, without a usable `last_page`, when `links.next` is empty, or when a page
 * has no items). A response with neither a numeric `meta.last_page` nor `links` can't be paginated
 * safely, so it throws instead of guessing. Breaking out of the loop stops requesting more pages.
 * `args` is never modified.
 *
 * The arguments are checked when `paginate()` is called, not when the first item is requested.
 *
 * @param {(op: any, args?: any) => Promise<any>} request
 * @param {string} operationId
 * @param {{ query?: Record<string, any>, [key: string]: any } | null=} args
 */
export function paginate(request, operationId, args) {
  const op = Object.hasOwn(operations, operationId) ? operations[operationId] : undefined;
  if (!op) throw new TypeError(`Unknown operation "${operationId}"`);
  if (!(op.params?.query ?? []).includes("page")) {
    throw new TypeError(`"${operationId}" is not a paginated operation`);
  }

  const start = args?.query?.page ?? 1;
  if (!Number.isInteger(start) || start < 1) {
    throw new TypeError(`The start page must be a positive integer, got ${String(start)}`);
  }

  return walk(request, op, operationId, args, start);
}

/**
 * @param {(op: any, args?: any) => Promise<any>} request
 * @param {any} op
 * @param {string} operationId
 * @param {{ query?: Record<string, any>, [key: string]: any } | null | undefined} args
 * @param {number} start
 */
async function* walk(request, op, operationId, args, start) {
  for (let page = start; ; page++) {
    const response = await request(op, { ...args, query: { ...args?.query, page } });
    const items = response?.data;
    if (!Array.isArray(items)) {
      throw new TypeError(`"${operationId}" did not return a "data" array, so it can't be paginated`);
    }

    const lastPage = response.meta?.last_page;
    const hasLastPage = Number.isFinite(lastPage);
    if (!hasLastPage && (typeof response.links !== "object" || response.links === null)) {
      throw new TypeError(
        `"${operationId}" returned no pagination information (meta.last_page or links), so it can't be paginated`,
      );
    }

    for (const item of items) yield item;

    if (items.length === 0) return;
    if (hasLastPage ? page >= lastPage : !response.links.next) return;
  }
}
