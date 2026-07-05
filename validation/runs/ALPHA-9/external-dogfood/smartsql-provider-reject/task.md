# Task

External repo: `/Users/evgeny/Documents/projects/smartsql`

Goal: prove the provider safety gate rejects an unsafe provider patch during external repo dogfood.

Failure command:

```bash
node -e "const fs=require('fs'); const text=fs.readFileSync('README.md','utf8'); if (text.includes('RunForge Alpha-9 rejected-provider marker')) process.exit(0); console.error('AssertionError: expected README to include RunForge Alpha-9 rejected-provider marker'); process.exit(1);"
```

Provider output attempted to patch `.env`, a forbidden path.

Workflow:

- `external check`
- `external failure-triage`
- `external proposal-readiness`
- `external code-proposal --enable-provider-proposal --provider cli`
- `packet inspect --validate`
- `packet inspect --validate --format mermaid`
- `packet view`
