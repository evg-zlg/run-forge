import { describe, expect, it } from "vitest";
import { decideCandidateAuthority } from "../../src/run/candidate-authority.js";

const base = { projectKind: "fullstack-app" as const, allowedFilePatterns: ["src/**", "tests/**", "docs/**"], forbiddenFilePatterns: ["**/.env*", "**/migrations/**", "**/infra/**"], publicationPermission: "draft_pr", publicationActionsCovered: true, validationConfidence: "high" as const, duplicateExisting: false };

describe("candidate-scoped authority", () => {
  it("allows a safe utility in an app that has project risk zones", () => expect(decideCandidateAuthority({ ...base, files: ["src/lib/date.ts"] })).toMatchObject({ risk: "safe-utility", decision: "draft-pr-allowed" }));
  it("requires an owner decision for auth fixtures", () => expect(decideCandidateAuthority({ ...base, files: ["src/auth/login.fixture.ts"] })).toMatchObject({ risk: "auth-sensitive", decision: "needs-owner-decision" }));
  it.each(["db/schema.ts", "migrations/001.sql"])("rejects DB and migration candidate %s", (file) => expect(decideCandidateAuthority({ ...base, files: [file], allowedFilePatterns: ["**"] })).toMatchObject({ decision: "rejected-risk" }));
  it("does not publish without discovered validation", () => expect(decideCandidateAuthority({ ...base, files: ["src/lib/date.ts"], validationConfidence: "low" })).toMatchObject({ decision: "patch-package-only" }));
  it.each([["docs/guide.md", "safe-docs"], ["tests/date.test.ts", "safe-test"], ["src/lib/date.ts", "safe-utility"]] as const)("allows safe candidate %s", (file, risk) => expect(decideCandidateAuthority({ ...base, files: [file] })).toMatchObject({ risk, decision: "draft-pr-allowed" }));
  it("prevents duplicate publication", () => expect(decideCandidateAuthority({ ...base, files: ["src/lib/date.ts"], duplicateExisting: true })).toMatchObject({ decision: "duplicate-existing" }));
  it("keeps DB-sensitive projects read-only", () => expect(decideCandidateAuthority({ ...base, files: ["docs/guide.md"], projectKind: "db-sensitive" })).toMatchObject({ decision: "read-only-triage" }));
  it("lets a safe allowlist override broad app risk only for that candidate", () => expect(decideCandidateAuthority({ ...base, files: ["src/utils/format.ts"] })).toMatchObject({ decision: "draft-pr-allowed" }));
  it("makes forbidden files win over a broad allowlist", () => expect(decideCandidateAuthority({ ...base, files: ["infra/readme.md"], allowedFilePatterns: ["**"] })).toMatchObject({ decision: "rejected-risk" }));
});
