import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import openapiTS, { astToString } from "openapi-typescript";

// Resolve everything from the repository root so the script works from any directory.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_CANDIDATES = [
  process.env.HAPIO_SPEC && path.resolve(process.env.HAPIO_SPEC),
  path.resolve(ROOT, "Hapio-API.v1.yaml"),
  path.resolve(ROOT, "../Hapio-API.v1.yaml"),
  path.resolve(ROOT, "../../Hapio-API.v1.yaml"),
].filter(Boolean);
const OUT_PATH = path.resolve(ROOT, "src/generated/operations.js");
const OUT_TYPES_PATH = path.resolve(ROOT, "src/generated/operations.d.ts");
const OUT_OPENAPI_TYPES_PATH = path.resolve(ROOT, "src/generated/openapi.d.ts");

/**
 * @param {any} root
 * @param {string} ref
 */
function resolveRef(root, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
  const parts = ref
    .slice(2)
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur = root;
  for (const p of parts) {
    if (!cur || typeof cur !== "object" || !(p in cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * @param {any} spec
 * @param {any} param
 */
function normalizeParameter(spec, param) {
  const p = param?.$ref ? resolveRef(spec, param.$ref) : param;
  if (!p || typeof p !== "object") return null;
  const name = p.name;
  const where = p.in;
  if (!name || !where) return null;
  return { name, in: where };
}

/**
 * @param {any} spec
 * @param {any} requestBody
 */
function pickDefaultContentType(spec, requestBody) {
  const rb = requestBody?.$ref ? resolveRef(spec, requestBody.$ref) : requestBody;
  const content = rb?.content;
  if (!content || typeof content !== "object") return undefined;
  if (content["application/json"]) return "application/json";
  const first = Object.keys(content)[0];
  return first || undefined;
}

function isHttpMethod(k) {
  return ["get", "post", "put", "patch", "delete", "head", "options"].includes(k);
}

/** @returns {Promise<string>} */
async function resolveSpecPath() {
  for (const candidate of SPEC_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }

  throw new Error(
    `OpenAPI spec not found. Tried:\n${SPEC_CANDIDATES.map((p) => `  - ${p}`).join("\n")}`,
  );
}

/** @param {string} s */
function jsString(s) {
  return JSON.stringify(String(s));
}

// The spec names these two operations `...RecurringScheduleScheduleBlock` (doubled "Schedule"),
// while the other operations on the same resource use `...RecurringScheduleBlock`. Rename them
// here so the client has consistent method names. Remove an entry once the spec itself is fixed.
const OPERATION_ID_OVERRIDES = {
  putResourceRecurringScheduleScheduleBlock: "putResourceRecurringScheduleBlock",
  patchResourceRecurringScheduleScheduleBlock: "patchResourceRecurringScheduleBlock",
};

const SPEC_PATH = await resolveSpecPath();
const raw = await readFile(SPEC_PATH, "utf8");
const spec = YAML.parse(raw);

// Apply the overrides to the spec itself, so the runtime operations and the generated
// openapi-typescript types agree on the names.
const appliedOverrides = new Set();
for (const pathItem of Object.values(spec?.paths ?? {})) {
  for (const op of Object.values(pathItem ?? {})) {
    const renamed = op && typeof op === "object" ? OPERATION_ID_OVERRIDES[op.operationId] : undefined;
    if (renamed) {
      appliedOverrides.add(op.operationId);
      op.operationId = renamed;
    }
  }
}
for (const oldId of Object.keys(OPERATION_ID_OVERRIDES)) {
  if (!appliedOverrides.has(oldId)) {
    console.warn(`Note: OPERATION_ID_OVERRIDES entry "${oldId}" matched nothing. Remove it if the spec was fixed.`);
  }
}

/**
 * Collects the names of writable `format: date-time` properties in a request body schema.
 * Read-only properties (such as `created_at`) are never sent, so they are skipped.
 *
 * @param {any} schema
 * @param {Set<string>} names
 * @param {Set<any>} seen
 */
function collectBodyTimestamps(schema, names, seen = new Set()) {
  const node = schema?.$ref ? resolveRef(spec, schema.$ref) : schema;
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  for (const key of ["allOf", "oneOf", "anyOf"]) {
    for (const sub of node[key] ?? []) collectBodyTimestamps(sub, names, seen);
  }
  if (node.items) collectBodyTimestamps(node.items, names, seen);
  for (const [name, prop] of Object.entries(node.properties ?? {})) {
    const resolved = prop?.$ref ? resolveRef(spec, prop.$ref) : prop;
    if (resolved?.readOnly) continue;
    if (resolved?.format === "date-time") names.add(name);
    collectBodyTimestamps(resolved, names, seen);
  }
}

const baseUrl =
  (Array.isArray(spec?.servers) && spec.servers[0]?.url) || "https://eu-central-1.hapio.net/v1";

/** @type {Record<string, any>} */
const operations = {};

/** @type {Record<string, { query: string[], body: string[] }>} */
const timestampFields = {};

for (const [p, pathItem] of Object.entries(spec?.paths ?? {})) {
  if (!pathItem || typeof pathItem !== "object") continue;
  const pathLevelParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];

  for (const [method, op] of Object.entries(pathItem)) {
    if (!isHttpMethod(method)) continue;
    if (!op || typeof op !== "object") continue;

    const operationId = op.operationId || `${method}_${p}`.replace(/[^\w]+/g, "_");
    const opParams = Array.isArray(op.parameters) ? op.parameters : [];
    const allParams = [...pathLevelParams, ...opParams]
      .map((par) => normalizeParameter(spec, par))
      .filter(Boolean);

    /** @type {{ path: string[], query: string[], header: string[] }} */
    const params = { path: [], query: [], header: [] };
    for (const par of allParams) {
      if (par.in === "path") params.path.push(par.name);
      else if (par.in === "query") params.query.push(par.name);
      else if (par.in === "header") params.header.push(par.name);
    }

    const defaultContentType = pickDefaultContentType(spec, op.requestBody);

    // Which query parameters and body properties are timestamps? The client types let callers pass
    // a `Date` for these (the runtime formats it), but not for plain `format: date` fields.
    const queryTimestamps = [...pathLevelParams, ...opParams]
      .map((par) => (par?.$ref ? resolveRef(spec, par.$ref) : par))
      .filter((par) => par?.in === "query" && par.schema?.format === "date-time")
      .map((par) => par.name);
    const bodyTimestampSet = new Set();
    const requestBody = op.requestBody?.$ref ? resolveRef(spec, op.requestBody.$ref) : op.requestBody;
    for (const media of Object.values(requestBody?.content ?? {})) {
      collectBodyTimestamps(media?.schema, bodyTimestampSet);
    }
    if (queryTimestamps.length || bodyTimestampSet.size) {
      timestampFields[operationId] = { query: queryTimestamps, body: [...bodyTimestampSet].sort() };
    }

    if (operations[operationId]) {
      throw new Error(`Duplicate operationId "${operationId}" (${method.toUpperCase()} ${p})`);
    }
    operations[operationId] = {
      method: method.toUpperCase(),
      path: p,
      defaultContentType,
      params,
    };
  }
}

const header = `// This file is generated by \`npm run generate\`.
// DO NOT EDIT MANUALLY.

export const baseUrl = ${jsString(baseUrl)};

/**
 * @type {Record<string, { method: string, path: string, defaultContentType?: string, params?: { path?: string[], query?: string[], header?: string[] } }>}
 */
export const operations = ${JSON.stringify(operations, null, 2)};
`;

/**
 * Spec names such as `starts_at[{operator}]` become template literal types, as in
 * `withBracketFilterKeys` below: `starts_at[${string}]`.
 *
 * @param {string[]} names
 */
function tsKeyUnion(names) {
  if (!names.length) return "never";
  return names
    .map((name) => (/\{[^}]+\}/.test(name) ? "`" + name.replace(/\{[^}]+\}/g, "${string}") + "`" : JSON.stringify(name)))
    .join(" | ");
}

const operationKeys = Object.keys(operations).sort();
const opsDtsHeader =
  `// This file is generated by \`npm run generate\`.\n` +
  `// DO NOT EDIT MANUALLY.\n\n`;

const opsDts =
  opsDtsHeader +
  `export type HapioOperationDefinition = {\n` +
  `  method: string;\n` +
  `  path: string;\n` +
  `  defaultContentType?: string;\n` +
  `  params?: { path?: string[]; query?: string[]; header?: string[] };\n` +
  `};\n\n` +
  `export declare const baseUrl: string;\n\n` +
  `export declare const operations: {\n` +
  operationKeys
    .map((k) => {
      const op = operations[k];
      const method = JSON.stringify(op.method);
      const p = JSON.stringify(op.path);
      const dct = op.defaultContentType ? `    defaultContentType?: ${JSON.stringify(op.defaultContentType)};\n` : "";
      return (
        `  ${JSON.stringify(k)}: {\n` +
        `    method: ${method};\n` +
        `    path: ${p};\n` +
        dct +
        `    params?: { path?: string[]; query?: string[]; header?: string[] };\n` +
        `  };\n`
      );
    })
    .join("") +
  `};\n\n` +
  `export type OperationId = keyof typeof operations;\n` +
  `export type OperationMeta<Id extends OperationId> = (typeof operations)[Id];\n\n` +
  `/**\n` +
  ` * The query parameters and request body properties that are timestamps, per operation. The client\n` +
  ` * types let callers pass a \`Date\` for these. Operations without timestamps are not listed.\n` +
  ` */\n` +
  `export type TimestampFields = {\n` +
  Object.keys(timestampFields)
    .sort()
    .map((id) => `  ${JSON.stringify(id)}: { query: ${tsKeyUnion(timestampFields[id].query)}; body: ${tsKeyUnion(timestampFields[id].body)} };\n`)
    .join("") +
  `};\n`;

await writeFile(OUT_PATH, header, "utf8");
await writeFile(OUT_TYPES_PATH, opsDts, "utf8");

/**
 * The spec names operator filters with placeholders, e.g. `starts_at[{operator}]` and
 * `metadata[{property}][{operator}]`. Callers pass concrete keys such as `starts_at[gte]` or
 * `metadata[status][eq]`, so turn each placeholder key into a template literal index signature:
 * `starts_at[{operator}]?: string` -> `[key: `starts_at[${string}]`]: string`.
 *
 * @param {string} dts
 */
function withBracketFilterKeys(dts) {
  return dts.replace(
    /^(\s*)"([^"\n]*\[\{[^"\n]*)"\?: ([^;\n]+);$/gm,
    (_, indent, key, type) =>
      `${indent}[key: \`${key.replace(/\{[^}]+\}/g, "${string}")}\`]: ${type};`,
  );
}

// Properties with a `default` (for example `is_temporary` and the `ignore_*` flags) are optional
// in request bodies, so don't let openapi-typescript turn them into required properties.
const openapiAst = await openapiTS(spec, { defaultNonNullable: false });

// The spec declares `metadata` and `protected_metadata` as a free-form `type: object`, which
// openapi-typescript emits as `Record<string, never>` (no keys allowed). The API accepts any JSON
// object there. Only those two properties are rewritten, not other empty-object types.
const openapiTypes =
  opsDtsHeader +
  withBracketFilterKeys(astToString(openapiAst)).replace(
    /\b((?:protected_)?metadata\??: )Record<string, never>/g,
    "$1Record<string, unknown>",
  );

if (openapiTypes.includes("[{")) {
  throw new Error("Unconverted bracket placeholder keys remain in the generated types.");
}

await writeFile(OUT_OPENAPI_TYPES_PATH, openapiTypes, "utf8");

console.log(
  `Generated ${Object.keys(operations).length} operations -> ${path.relative(ROOT, OUT_PATH)} (+ .d.ts files)`,
);

