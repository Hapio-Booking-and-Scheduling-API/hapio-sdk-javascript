import { HapioError } from "./errors.js";

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
        sp.append(k, String(item));
      }
      continue;
    }
    sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
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
 * }} config
 */
export function createRequester(config) {
  const { baseUrl, token, fetchImpl, defaultHeaders } = config;
  if (typeof fetchImpl !== "function") {
    throw new Error(
      "No fetch() implementation available. Use Node 18+ or pass { fetch } to createHapioClient().",
    );
  }

  /**
   * @param {{ method: string, path: string, defaultContentType?: string }} op
   * @param {RequestArgs=} args
   */
  return async function request(op, args = {}) {
    const url = buildPath(baseUrl, op.path, args.path) + buildQueryString(args.query);

    /** @type {Record<string, string>} */
    const headers = {
      ...(defaultHeaders ?? {}),
      ...(args.headers ?? {}),
    };

    if (token && !headers.authorization && !headers.Authorization) {
      headers.Authorization = `Bearer ${token}`;
    }

    /** @type {any} */
    let body = undefined;
    const methodUpper = String(op.method).toUpperCase();
    const hasBody = args.body !== undefined && args.body !== null && methodUpper !== "GET" && methodUpper !== "HEAD";
    if (hasBody) {
      const ct = headers["content-type"] ?? headers["Content-Type"] ?? op.defaultContentType ?? "application/json";
      if (!headers["content-type"] && !headers["Content-Type"]) headers["Content-Type"] = ct;
      if (ct.includes("application/json")) {
        body = JSON.stringify(args.body);
        if (!headers.Accept) headers.Accept = "application/json";
      } else {
        body = args.body;
      }
    } else {
      if (!headers.Accept) headers.Accept = "application/json";
    }

    const res = await fetchImpl(url, {
      method: methodUpper,
      headers,
      body,
      signal: args.signal,
    });

    // No content (common for DELETE operations).
    if (res.status === 204 || res.status === 205) return undefined;

    const resContentType = res.headers.get("content-type") ?? "";
    const isJson = resContentType.includes("application/json");
    const data = isJson ? await res.json().catch(() => null) : await res.text().catch(() => "");

    if (!res.ok) {
      throw new HapioError(`Hapio API error (${res.status})`, {
        status: res.status,
        data,
        headers: headersToObject(res.headers),
      });
    }

    return data;
  };
}

