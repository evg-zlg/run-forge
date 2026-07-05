# Post-Apply Validation

Validated after manual application:

- `pnpm typecheck` passed.
- `pnpm exec vitest run tests/integration/alpha6-packet-provider.test.ts` passed, 6 tests.
- `pnpm validation:packets` passed, including provider proposal packet validation and static viewer generation.
- `pnpm test` passed, 101 tests.
- `pnpm build` passed.
