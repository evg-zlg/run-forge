# AI-native codebase structure

RunForge is built for humans and agents to modify together. Source files should keep the relevant context local, small, and consistent.

## Rule

Files under `src/**` should target 250 lines or fewer.

- Target: `<= 250` lines.
- Warn: `> 300` lines.
- Fail: `> 350` lines.

The structure check excludes generated files, fixtures, logs, lockfiles, snapshots, and docs.

## Command

```bash
pnpm check:structure
```

`pnpm test` runs `pnpm check:structure` before unit and integration tests. If CI is added, it should run `pnpm test` or explicitly run `pnpm check:structure`.

## Rationale

Agents work better when the relevant context is local, small, and consistent. Large files make context selection worse, increase token cost, and encourage local patches that ignore shared utilities.
