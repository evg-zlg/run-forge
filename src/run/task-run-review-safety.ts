import type { TaskRunResult } from "./task-run-harness.js";

export function reviewSafety(result: TaskRunResult): Record<string, unknown> {
  const metadata = result.review.providerMetadataPayload;
  if (metadata) {
    return {
      mode: metadata.mode,
      readOnly: metadata.readOnly,
      mutationForbidden: metadata.mutationForbidden,
      networkAccess: metadata.networkAccess,
      secretsAccess: metadata.secretsAccess,
      repoAccess: metadata.repoAccess
    };
  }
  return {
    mode: "providerless",
    readOnly: true,
    mutationForbidden: true,
    networkAccess: "not_requested",
    secretsAccess: "not_requested",
    repoAccess: "evidence_packet_only"
  };
}
