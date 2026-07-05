# Dogfood Task: Provider Audit Docs

Desired check: packet schema docs should describe `providerAudit` fields and Alpha-8 validation behavior.

Check command:

```bash
node -e "const fs=require('fs'); const text=fs.readFileSync('docs/packet-schema.md','utf8'); if (text.includes('Provider audit fields')) process.exit(0); console.error('AssertionError: expected packet schema docs to describe Provider audit fields'); process.exit(1);"
```

RunForge loop used provider-backed proposal mode with explicit gate and a disposable workspace.
