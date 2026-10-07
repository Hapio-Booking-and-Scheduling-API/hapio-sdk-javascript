import { HapioError } from "./errors.js";

/**
 * Formats a date the way the Hapio API expects timestamps: `YYYY-MM-DDThh:mm:ss+00:00`
 * (UTC, no milliseconds). `Date.prototype.toISOString()` (`...000Z`) is rejected by the API.
 *
 * @param {Date} date
 * @returns {string}
 */
export function formatTimestamp(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError("formatTimestamp() expects a valid Date");
  }
  return `${date.toISOString().slice(0, 19)}+00:00`;
}

/**
 * @param {string} baseUrl
 * @param {string} pathTemplate
 * @param {Record<string, any> | undefined} pathParams
 */
function buildPath(baseUrl, pathTemplate, pathParams) {
  const base = baseUrl.replace(/\/+$/, "");
  const path = pathTemplate.replace(/\{([^}]+)\}/g, (_, key) => {
    const v = pathParams?.[key];
    if (v === undefined || v === null || v === "") {
      throw new Error(`Missing required path param "${key}"`);
    }
    return encodeURIComponent(String(v));
  });
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

/**
 * @param {unknown} value
 */
function queryValue(value) {
  return value instanceof Date ? formatTimestamp(value) : String(value);
}

/**
 * @param {Record<string, any> | undefined} query
 */
function buildQueryString(query) {
  if (!query) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item === undefined || item === null) continue;
        sp.append(k, queryValue(item));
      }
      continue;
    }
    sp.set(k, queryValue(v));
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

/**
 * JSON.stringify replacer that formats `Date` values for the API instead of using `toISOString()`.
 *
 * @this {any}
 * @param {string} key
 * @param {any} value
 */
function jsonReplacer(key, value) {
  const original = this[key];
  return original instanceof Date ? formatTimestamp(original) : value;
}

/**
 * Merges header objects case-insensitively. Later objects win, and the casing of the winning
 * name is kept, so `{ "x-app": "1" }` followed by `{ "X-App": "2" }` yields `{ "X-App": "2" }`.
 *
 * @param {...(Record<string, string> | undefined)} sources
 * @returns {Record<string, string>}
 */
function mergeHeaders(...sources) {
  /** @type {Map<string, [string, string]>} */
  const merged = new Map();
  for (const source of sources) {
    for (const [name, value] of Object.entries(source ?? {})) {
      merged.set(name.toLowerCase(), [name, value]);
    }
  }
  return Object.fromEntries(merged.values());
}

/**
 * @param {Record<string, string>} headers
 * @param {string} name
 */
function findHeader(headers, name) {
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === wanted) return v;
  }
  return undefined;
}

/**
 * @param {Headers} headers
 */
function headersToObject(headers) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of headers.entries()) out[k] = v;
  return out;
}

/**
 * Matches `application/json`, `application/problem+json`, `application/vnd.api+json`, etc.
 *
 * @param {string} contentType
 */
function isJsonContentType(contentType) {
  return /[/+]json(?:\s*;|\s*$)/i.test(contentType);
}

/**
 * @typedef {object} RetryOptions
 * @property {number=} attempts Retries after the first attempt (default 3).
 * @property {number=} baseDelayMs Delay before the first retry when the response has no usable `Retry-After` header. Doubles on every retry (default 1000).
 * @property {number=} maxDelayMs Longest wait that is acceptable (default 60000, the API's rate limit window). A longer `Retry-After` is not waited for, and the 429 is thrown instead.
 */

const DEFAULT_RETRY = { attempts: 3, baseDelayMs: 1000, maxDelayMs: 60_000 };

/**
 * @param {boolean | RetryOptions | undefined} retry
 * @returns {{ attempts: number, baseDelayMs: number, maxDelayMs: number }}
 */
function normalizeRetry(retry) {
  if (retry === undefined || retry === false) return { ...DEFAULT_RETRY, attempts: 0 };
  const merged = { ...DEFAULT_RETRY, ...(retry === true ? {} : retry) };
  for (const [name, value] of Object.entries(merged)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`Invalid retry option "${name}": expected a non-negative number`);
    }
  }
  merged.attempts = Math.floor(merged.attempts);
  return merged;
}

/**
 * How long to wait before retrying a 429, or `undefined` if the wait would be longer than allowed.
 * Uses `Retry-After` (seconds or an HTTP date) when present, otherwise exponential backoff.
 *
 * @param {Headers} headers
 * @param {number} attempt Zero-based number of the attempt that was just rejected.
 * @param {{ baseDelayMs: number, maxDelayMs: number }} retry
 */
function retryDelayMs(headers, attempt, retry) {
  const header = headers.get("retry-after");
  /** @type {number | undefined} */
  let delay;
  if (header) {
    const seconds = Number(header);
    const ms = header.trim() !== "" && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    if (Number.isFinite(ms)) delay = Math.max(0, ms);
  }
  delay ??= retry.baseDelayMs * 2 ** attempt;
  if (delay > retry.maxDelayMs) return undefined;
  // A little jitter (at most one second), so many clients that were limited together don't all
  // retry at exactly the same moment.
  return delay + Math.random() * Math.min(0.2 * delay, 1000);
}

/**
 * Resolves after `ms`, or rejects with the abort reason if the signal fires first.
 *
 * @param {number} ms
 * @param {AbortSignal=} signal
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(undefined);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * @typedef {object} RequestArgs
 * @property {Record<string, any>=} path
 * @property {Record<string, any>=} query
 * @property {any=} body
 * @property {Record<string, string>=} headers
 * @property {AbortSignal=} signal
 */

/**
 * @param {{
 *   baseUrl: string,
 *   token?: string,
 *   fetchImpl: typeof fetch,
 *   defaultHeaders?: Record<string, string>,
 *   retry?: boolean | RetryOptions,
 * }} config
 */
export function createRequester(config) {
  const { baseUrl, token, fetchImpl, defaultHeaders } = config;
  const retry = normalizeRetry(config.retry);
  if (typeof fetchImpl !== "function") {
    throw new Error(
      "No fetch() implementation available. Use a supported Node.js version (see the README) or pass { fetch } to createHapioClient().",
    );
  }

  /**
   * @param {{ method: string, path: string, defaultContentType?: string }} op
   * @param {RequestArgs | null=} args
   */
  return async function request(op, args) {
    const { path: pathParams, query, body: bodyArg, headers: callHeaders, signal } = args ?? {};
    const url = buildPath(baseUrl, op.path, pathParams) + buildQueryString(query);

    const headers = mergeHeaders(defaultHeaders, callHeaders);

    if (token && findHeader(headers, "authorization") === undefined) {
      headers.Authorization = `Bearer ${token}`;
    }

    /** @type {any} */
    let body = undefined;
    const methodUpper = String(op.method).toUpperCase();
    const hasBody = bodyArg !== undefined && bodyArg !== null && methodUpper !== "GET" && methodUpper !== "HEAD";
    if (hasBody) {
      const ct = findHeader(headers, "content-type") ?? op.defaultContentType ?? "application/json";
      if (findHeader(headers, "content-type") === undefined) headers["Content-Type"] = ct;
      if (ct.includes("application/json")) {
        body = JSON.stringify(bodyArg, jsonReplacer);
      } else {
        body = bodyArg;
      }
    }
    if (findHeader(headers, "accept") === undefined) headers.Accept = "application/json";

    // A 429 means the request was not processed, so retrying is safe for every method. A streamed
    // body can only be sent once, so those requests are never retried.
    const replayable = !(body && typeof body.getReader === "function");
    /** @type {Response} */
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await fetchImpl(url, {
        method: methodUpper,
        headers,
        body,
        signal,
      });
      if (res.status !== 429 || attempt >= retry.attempts || !replayable) break;
      const delay = retryDelayMs(res.headers, attempt, retry);
      if (delay === undefined) break;
      await res.text().catch(() => ""); // release the connection before waiting
      await sleep(delay, signal);
    }

    // No content (common for DELETE operations).
    if (res.status === 204 || res.status === 205) return undefined;

    const resContentType = res.headers.get("content-type") ?? "";
    const text = await res.text().catch(() => "");
    /** @type {any} */
    let data = text;
    if (isJsonContentType(resContentType)) {
      if (!text) {
        data = null;
      } else {
        try {
          data = JSON.parse(text);
        } catch {
          // Keep the raw text for error responses, but don't hand back garbage as a success.
          if (res.ok) {
            throw new HapioError(`Hapio API returned invalid JSON (${res.status})`, {
              status: res.status,
              data: text,
              headers: headersToObject(res.headers),
            });
          }
          data = text;
        }
      }
    }

    if (!res.ok) {
      const detail = data && typeof data === "object" && typeof data.message === "string" ? data.message : "";
      throw new HapioError(`Hapio API error (${res.status})${detail ? `: ${detail}` : ""}`, {
        status: res.status,
        data,
        headers: headersToObject(res.headers),
      });
    }

    return data;
  };
}
