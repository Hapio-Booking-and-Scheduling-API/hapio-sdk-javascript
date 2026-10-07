import { readFile } from "node:fs/promises";
import { operations } from "../src/generated/operations.js";

// Verifies that the three generated files agree with each other: the runtime operations map
// (operations.js), its typings (operations.d.ts), and the openapi-typescript output (openapi.d.ts).
// It does not regenerate anything, because the spec is not part of the published package.

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const problems = [];
const ids = Object.keys(operations);
if (!ids.length) {
  console.error("No operations found. Did you run `npm run generate`?");
  process.exit(1);
}

// operations.d.ts: "id": { method: "GET"; path: "/x"; ... }
const dts = await read("src/generated/operations.d.ts");
const typed = new Map(
  [...dts.matchAll(/^  "([^"]+)": \{\n    method: "([A-Z]+)";\n    path: "([^"]+)";/gm)].map((m) => [m[1], { method: m[2], path: m[3] }]),
);
for (const id of ids) {
  const entry = typed.get(id);
  if (!entry) problems.push(`operations.d.ts has no entry for "${id}"`);
  else if (entry.method !== operations[id].method || entry.path !== operations[id].path) {
    problems.push(`"${id}" is ${operations[id].method} ${operations[id].path} in operations.js but ${entry.method} ${entry.path} in operations.d.ts`);
  }
}
for (const id of typed.keys()) if (!operations[id]) problems.push(`operations.d.ts has "${id}", which operations.js does not`);

// openapi.d.ts: `interface operations { id: {` and `get: operations["id"];` under the right path
const openapi = await read("src/generated/openapi.d.ts");
const operationsBlock = openapi.slice(openapi.indexOf("export interface operations {"));
const documented = new Set([...operationsBlock.matchAll(/^    ([A-Za-z0-9_]+): \{$/gm)].map((m) => m[1]));
for (const id of ids) {
  if (!documented.has(id)) problems.push(`openapi.d.ts has no operation "${id}"`);
  const method = operations[id].method.toLowerCase();
  if (!openapi.includes(`${method}: operations["${id}"];`)) {
    problems.push(`openapi.d.ts does not connect ${operations[id].method} ${operations[id].path} to "${id}"`);
  }
  if (!openapi.includes(`"${operations[id].path}": {`)) problems.push(`openapi.d.ts has no path "${operations[id].path}" (for "${id}")`);
}
for (const id of documented) if (!operations[id]) problems.push(`openapi.d.ts has operation "${id}", which operations.js does not`);

// TimestampFields must only mention existing operations
const timestampBlock = dts.slice(dts.indexOf("export type TimestampFields"));
for (const m of timestampBlock.matchAll(/^  "([^"]+)": \{ query:/gm)) {
  if (!operations[m[1]]) problems.push(`TimestampFields mentions unknown operation "${m[1]}"`);
}

if (problems.length) {
  console.error(`Generated files are inconsistent. Run \`npm run generate\`.\n- ${problems.join("\n- ")}`);
  process.exit(1);
}

console.log(`OK: ${ids.length} operations loaded, and operations.js, operations.d.ts and openapi.d.ts agree.`);
