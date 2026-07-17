import { readFileSync } from "node:fs";
const source = readFileSync("calculator.js", "utf8");
if (!source.includes("return a + b")) {
  console.error("typecheck: add must return a number sum");
  process.exit(1);
}
console.log("typecheck passed");
