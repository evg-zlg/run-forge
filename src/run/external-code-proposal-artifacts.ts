import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { artifactTypeFor, type ArtifactRecord } from "./external-command-check-packet.js";

export function createCodeProposalArtifactTracker(input: {
  runId: string;
  packetDir: string;
  schemaVersion: string;
}) {
  const events: Array<Record<string, unknown>> = [];
  const artifacts = new Map<string, ArtifactRecord>();
  let eventCounter = 0;
  const emit = (type: string, data: object = {}) => {
    eventCounter += 1;
    const event = {
      schemaVersion: input.schemaVersion,
      eventId: `${input.runId}:event:${String(eventCounter).padStart(4, "0")}`,
      runId: input.runId,
      type,
      time: new Date().toISOString(),
      ...data
    };
    events.push(event);
    return event.eventId;
  };
  const markArtifact = async (artifactPath: string, artifactType = artifactTypeFor(artifactPath)) => {
    const fullPath = join(input.packetDir, artifactPath);
    const info = await stat(fullPath);
    const hash = createHash("sha256").update(await readFile(fullPath)).digest("hex");
    const record: ArtifactRecord = {
      artifactId: `${input.runId}:artifact:${artifactPath}`,
      artifactPath,
      artifactType,
      artifactBytes: info.size,
      hash,
      createdAt: new Date().toISOString()
    };
    artifacts.set(artifactPath, record);
    emit("artifact_written", record);
  };
  return { events, artifacts, emit, markArtifact };
}
