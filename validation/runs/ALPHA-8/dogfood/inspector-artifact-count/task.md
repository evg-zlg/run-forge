# Dogfood Task: Inspector Artifact Count

Desired check: text packet inspection should show the number of artifacts from the manifest.

Check command:

```bash
node -e "const fs=require('fs'); const text=fs.readFileSync('src/run/packet-inspector.ts','utf8'); if (text.includes('Artifact count:')) process.exit(0); console.error('AssertionError: expected packet inspector text output to include Artifact count'); process.exit(1);"
```

RunForge loop used provider-backed proposal mode with explicit gate and a disposable workspace.
