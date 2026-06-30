import type { ReviewModel } from "./types.js";

export function renderReview(review: ReviewModel): string {
  return `# Failure Triage Report

## Verdict

- Category: ${review.category}
- Root cause: ${review.rootCause}
- Confidence: ${review.confidence}
- Human decision needed: ${review.humanDecisionNeeded ? "yes" : "no"}

## Summary

${bullets(review.summary)}

## Evidence

### Log excerpts

${bullets(review.logExcerpts)}

### Relevant files

${bullets(review.relevantFiles)}

### Relevant package scripts / commands

${bullets(review.relevantCommands)}

## Checked

${bullets(review.checked)}

## Not checked

${bullets(review.notChecked)}

## Safe next command

\`\`\`bash
${review.safeNextCommand ?? "# No safe diagnostic command could be determined."}
\`\`\`

## Why this command is safe

${review.whyCommandIsSafe}

## Risks / caveats

${bullets(review.risks)}

## Suggested follow-up

${bullets(review.followUp)}
`;
}

function bullets(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None.";
}
