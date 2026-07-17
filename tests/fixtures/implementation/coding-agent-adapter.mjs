import { readFileSync, writeFileSync, existsSync } from "node:fs";

const prompt = process.env.RUNFORGE_IMPLEMENTATION_PROMPT ?? "";
if (!prompt.includes("Do not create a Git commit; leave changes uncommitted")) { console.error("missing RunForge-owned commit instruction"); process.exit(2); }
else if (prompt.includes("CANCEL_FOREVER")) setInterval(() => {}, 1000);
else if (prompt.includes("AMBIGUOUS_CHANGE")) console.log("ambiguous product decision");
else if (prompt.includes("FALSE_POSITIVE")) console.log("no change required: current behavior already satisfies the criterion");
else if (prompt.includes("FORBIDDEN_CHANGE")) { writeFileSync("secrets.txt", "forbidden\n"); console.log("changed forbidden fixture path"); }
else {
  const path = "calculator.js";
  let source = readFileSync(path, "utf8");
  if (prompt.includes("REPAIR_LOOP") && prompt.includes("Iteration: 0")) source = source.replace("return a - b", "return a * b");
  else source = source.replace(/return a [-*] b/, "return a + b").replace("var ", "const ");
  writeFileSync(path, source);
  if (prompt.includes("ADD_TEST") && !existsSync("added.test.js")) writeFileSync("added.test.js", "import { add } from './calculator.js';\nif (add(2, 2) !== 4) process.exit(1);\n");
  console.log("implemented bounded change and tests");
}
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 80, output_tokens: 20 } }));
