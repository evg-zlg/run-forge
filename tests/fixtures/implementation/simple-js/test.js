import { add } from "./calculator.js";
if (add(1, 2) !== 3) {
  console.error("expected add(1, 2) to equal 3");
  process.exit(1);
}
console.log("tests passed");
