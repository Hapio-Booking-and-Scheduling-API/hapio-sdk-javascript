import type { operations, OperationId, OperationMeta } from "../generated/operations.js";
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
type BodyParams<Id extends OperationId> = Maybe<
  OpObject<Id> extends { requestBody?: { content: infer C } } ? C[keyof C] : never
>;

type Responses<Id extends OperationId> = OpObject<Id> extends { responses: infer R } ? R : never;
type SuccessResponse<R> =
  R extends { 200: infer X } ? X :
  R extends { 201: infer X } ? X :
  R extends { 202: infer X } ? X :
  R extends { 204: infer X } ? X :
  R extends { default: infer X } ? X :
  never;
type ContentOf<R> = R extends { content: infer C } ? C[keyof C] : void;
export type HapioResponse<Id extends OperationId> = ContentOf<SuccessResponse<Responses<Id>>>;

export type HapioRequestArgs<Id extends OperationId = OperationId> = {
  path?: PathParams<Id>;
  query?: QueryParams<Id>;
  body?: BodyParams<Id>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

export type HapioClientOptions = {
  token?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
};

export type HapioOperationDefinition = {
  method: string;
  path: string;
  defaultContentType?: string;
  params?: { path?: string[]; query?: string[]; header?: string[] };
};

export type HapioClient = {
  baseUrl: string;
  operations: typeof operations;
  request: <Id extends OperationId>(op: OperationMeta<Id>, args?: HapioRequestArgs<Id>) => Promise<HapioResponse<Id>>;
} & {
  [K in OperationId]: (args?: HapioRequestArgs<K>) => Promise<HapioResponse<K>>;
};

export declare function createHapioClient(options?: HapioClientOptions): HapioClient;

