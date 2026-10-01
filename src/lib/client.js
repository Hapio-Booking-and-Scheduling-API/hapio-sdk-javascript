import { createRequester } from "./http.js";
import { baseUrl as generatedBaseUrl, operations } from "../generated/operations.js";

/**
 * @typedef {object} HapioClientOptions
 * @property {string=} token
 * @property {string=} baseUrl
 * @property {typeof fetch=} fetch
 * @property {Record<string, string>=} headers
 */

/**
 * Creates a Hapio client with methods based on OpenAPI `operationId`.
 *
 * Each generated method accepts a single `args` object:
 * - `path`: path params (e.g. `{ booking: "uuid" }`)
 * - `query`: query params
 * - `body`: request body (for POST/PATCH/PUT)
 * - `headers`: per-request headers
 * - `signal`: AbortSignal
 *
 * @param {HapioClientOptions=} options
 */
export function createHapioClient(options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? generatedBaseUrl ?? "https://eu-central-1.hapio.net/v1";

  const request = createRequester({
    baseUrl,
    token: options.token,
    fetchImpl,
    defaultHeaders: options.headers,
  });

  /** @type {any} */
  const client = {
    baseUrl,
    operations,
    request,
  };

  for (const [operationId, op] of Object.entries(operations)) {
    if (!operationId) continue;
    if (client[operationId]) continue;
    client[operationId] = (args) => request(op, args);
  }

  return client;
}

