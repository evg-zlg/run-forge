import { readFileSync } from "node:fs";
const source = readFileSync("calculator.js", "utf8");
if (source.includes("var ")) {
  console.error("lint: unexpected var");
  process.exit(1);
}
console.log("lint passed");
