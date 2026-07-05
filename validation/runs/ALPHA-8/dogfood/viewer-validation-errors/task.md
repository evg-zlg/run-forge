# Dogfood Task: Viewer Validation Errors

Desired check: exported packet viewer HTML should expose validation errors as a readable first-class section.

Check command:

```bash
node -e "const fs=require('fs'); const text=fs.readFileSync('src/run/packet-viewer.ts','utf8'); if (text.includes('Validation Errors')) process.exit(0); console.error('AssertionError: expected packet viewer to expose Validation Errors section'); process.exit(1);"
```

RunForge loop used `external check`, `external failure-triage`, `external proposal-readiness`, and provider-gated `external code-proposal` with a disposable workspace.
