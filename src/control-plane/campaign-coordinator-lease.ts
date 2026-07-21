import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ControlPlaneError } from "./contracts.js";

type Owner = { schemaVersion: 1; pid: number; token: string; acquiredAt: string };

/** Process-wide ownership for one control-plane state root. */
export class CampaignCoordinatorLease {
  private readonly token = randomUUID();
  private readonly lockDir: string;
  private held = false;
  constructor(root: string, private readonly ownerlessStaleMs = 5_000) { this.lockDir = join(root, ".campaign-coordinator.lock"); }
  get active(): boolean { return this.held; }
  acquire(): void {
    if (this.held) return;
    mkdirSync(join(this.lockDir, ".."), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        mkdirSync(this.lockDir);
        const owner: Owner = { schemaVersion: 1, pid: process.pid, token: this.token, acquiredAt: new Date().toISOString() };
        writeFileSync(this.ownerPath(), JSON.stringify(owner) + "\n", { encoding: "utf8", flag: "wx" });
        this.held = true;
        return;
      } catch (error) {
        const owner = this.readOwner();
        if (owner && !processAlive(owner.pid)) { rmSync(this.lockDir, { recursive: true, force: true }); continue; }
        if (!owner && this.ownerlessAgeMs() >= this.ownerlessStaleMs) { rmSync(this.lockDir, { recursive: true, force: true }); continue; }
        throw new ControlPlaneError(409, "campaign_coordinator_already_active", "Another campaign coordinator already owns this control-plane state root.", owner ? { ownerPid: owner.pid, acquiredAt: owner.acquiredAt } : undefined);
      }
    }
    throw new ControlPlaneError(409, "campaign_coordinator_already_active", "The stale campaign coordinator lease could not be replaced safely.");
  }
  release(): void {
    if (!this.held) return;
    const owner = this.readOwner();
    if (owner?.token === this.token) rmSync(this.lockDir, { recursive: true, force: true });
    this.held = false;
  }
  private ownerPath(): string { return join(this.lockDir, "owner.json"); }
  private readOwner(): Owner | null { try { const value = JSON.parse(readFileSync(this.ownerPath(), "utf8")) as Partial<Owner>; return value.schemaVersion === 1 && Number.isInteger(value.pid) && typeof value.token === "string" && typeof value.acquiredAt === "string" ? value as Owner : null; } catch { return null; } }
  private ownerlessAgeMs(): number { try { return Math.max(0, Date.now() - statSync(this.ownerPath()).mtimeMs); } catch { try { return Math.max(0, Date.now() - statSync(this.lockDir).mtimeMs); } catch { return 0; } } }
}

function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } }
