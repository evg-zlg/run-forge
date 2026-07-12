# Validation report

Target: Управдом commit `4c98e96d33321f2ab194dc11d053fc6b86996a63` on `runforge/add-decimal-radix-date`.

All executable validation used OS-level network denial.

- Patch SHA-256 matched manifest: passed.
- `git apply --check` against current main: passed.
- `git diff --check`: passed.
- Direct `utcToDate('2026-07-12')` component assertion: passed.
- ESLint for `src/lib/date.ts`: passed.
- Full ESLint: passed.
- Vitest: 39 files, 181 tests passed.
- Next production build with webpack: passed, including TypeScript, page-data collection, and 15 static pages.
- Default Turbopack build: environment-blocked because strict network denial rejected an internal local port bind. It did not attempt registry access and is superseded by the passing webpack build.
- Independent review: no findings; scope and validation judged owner-ready.

Validation verdict: **acceptable for draft PR publication**.
