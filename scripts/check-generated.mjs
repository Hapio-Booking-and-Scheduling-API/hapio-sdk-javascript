import { operations } from "../src/generated/operations.js";

const count = Object.keys(operations).length;
if (!count) {
  console.error("No operations found. Did you run `npm run generate`?");
  process.exit(1);
}

console.log(`OK: ${count} operations loaded.`);

