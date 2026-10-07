import type { operations, OperationId, OperationMeta, TimestampFields } from "../generated/operations.js";
import type { paths } from "../generated/openapi.js";

type LowercaseMethod<M extends string> = Lowercase<M>;
type Maybe<T> = [T] extends [never] ? undefined : T;

type OpObject<Id extends OperationId> =
  OperationMeta<Id>["path"] extends keyof paths
    ? LowercaseMethod<OperationMeta<Id>["method"]> extends keyof paths[OperationMeta<Id>["path"]]
      ? paths[OperationMeta<Id>["path"]][LowercaseMethod<OperationMeta<Id>["method"]>]
      : never
    : never;

type PathParams<Id extends OperationId> = Maybe<
  OpObject<Id> extends { parameters?: { path?: infer P } } ? P : never
>;
type QueryParams<Id extends OperationId> = Maybe<
  OpObject<Id> extends { parameters?: { query?: infer Q } } ? Q : never
>;
// The client always speaks JSON, so use the `application/json` media type when the spec lists several
// (some responses also list `application/xml: Record<string, unknown>`, which would turn every field
// of the response into `unknown`).
type JsonContent<C> = C extends { "application/json": infer Json } ? Json : C[keyof C];

type BodyParams<Id extends OperationId> = Maybe<
  OpObject<Id> extends { requestBody?: { content: infer C } } ? JsonContent<C> : never
>;

type Responses<Id extends OperationId> = OpObject<Id> extends { responses: infer R } ? R : never;
type SuccessResponse<R> =
  R extends { 200: infer X } ? X :
  R extends { 201: infer X } ? X :
  R extends { 202: infer X } ? X :
  R extends { 204: infer X } ? X :
  R extends { default: infer X } ? X :
  never;
type ContentOf<R> = R extends { content: infer C } ? JsonContent<C> : void;
export type HapioResponse<Id extends OperationId> = ContentOf<SuccessResponse<Responses<Id>>>;

/**
 * Lets callers pass a `Date` wherever the API expects a timestamp. The client formats it as
 * `YYYY-MM-DDThh:mm:ss+00:00`. Only request arguments are widened, responses keep plain strings,
 * and `format: date` fields (such as `start_date`) still take strings only.
 */
type WithDates<T, Keys> =
  T extends readonly (infer Item)[]
    ? WithDates<Item, Keys>[]
    : T extends object
      ? { [P in keyof T]: P extends Keys ? T[P] | Date : WithDates<T[P], Keys> }
      : T;
type DateKeys<Id extends OperationId, Part extends "query" | "body"> =
  Id extends keyof TimestampFields ? TimestampFields[Id][Part] : never;

export type HapioRequestArgs<Id extends OperationId = OperationId> = {
  path?: PathParams<Id>;
  query?: WithDates<QueryParams<Id>, DateKeys<Id, "query">>;
  body?: WithDates<BodyParams<Id>, DateKeys<Id, "body">>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

export type HapioRetryOptions = {
  /** Retries after the first attempt. Default 3. */
  attempts?: number;
  /** Delay before the first retry when the response has no usable `Retry-After` header. Doubles on every retry. Default 1000. */
  baseDelayMs?: number;
  /** Longest wait that is acceptable. A longer `Retry-After` is not waited for, and the 429 is thrown instead. Default 60000, the API's rate limit window. */
  maxDelayMs?: number;
};

export type HapioClientOptions = {
  token?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  /** Retry requests that get a `429 Too Many Attempts`, honouring `Retry-After`. Off by default. */
  retry?: boolean | HapioRetryOptions;
};

/** Operations that return a page of results (`{ data, links, meta }`) and can be used with `paginate()`. */
export type PaginatedOperationId = {
  [K in OperationId]: "data" extends keyof HapioResponse<K> ? ("meta" extends keyof HapioResponse<K> ? K : never) : never;
}[OperationId];

type PageItem<Id extends OperationId> =
  HapioResponse<Id> extends { data?: infer Data }
    ? NonNullable<Data> extends readonly (infer Item)[]
      ? Item
      : never
    : never;

export type HapioClient = {
  baseUrl: string;
  operations: typeof operations;
  /**
   * Walks every page of a paginated operation and yields the items one by one. Starts at
   * `query.page` (default 1) and stops after the last page. Breaking out of the loop stops
   * requesting further pages.
   */
  paginate: <Id extends PaginatedOperationId>(
    operationId: Id,
    args?: HapioRequestArgs<Id>,
  ) => AsyncGenerator<PageItem<Id>, void, undefined>;
  request: <Id extends OperationId>(op: OperationMeta<Id>, args?: HapioRequestArgs<Id>) => Promise<HapioResponse<Id>>;
} & {
  [K in OperationId]: (args?: HapioRequestArgs<K>) => Promise<HapioResponse<K>>;
};

export declare function createHapioClient(options?: HapioClientOptions): HapioClient;

