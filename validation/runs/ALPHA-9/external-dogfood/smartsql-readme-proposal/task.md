# Task

External repo: `/Users/evgeny/Documents/projects/smartsql`

Goal: prove RunForge can produce a useful provider-backed proposal packet on a real external local repo without mutating that repo.

Failure command:

```bash
node -e "const fs=require('fs'); const text=fs.readFileSync('README.md','utf8'); if (text.includes('RunForge Alpha-9 external dogfood marker')) process.exit(0); console.error('AssertionError: expected README to include RunForge Alpha-9 external dogfood marker'); process.exit(1);"
```

Workflow:

- `external check`
- `external failure-triage`
- `external proposal-readiness`
- `external code-proposal --enable-provider-proposal --provider cli`
- `packet inspect --validate`
- `packet inspect --validate --format mermaid`
- `packet view`
