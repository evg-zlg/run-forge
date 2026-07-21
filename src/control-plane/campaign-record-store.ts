import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CampaignRecord } from "./contracts.js";

export class CampaignRecordStore {
  constructor(private readonly root: string) {}
  async save(campaign: CampaignRecord, beforeCommit?: () => void): Promise<void> { await mkdir(this.directory(), { recursive: true }); const destination = this.path(campaign.id), temp = `${destination}.${process.pid}.${randomUUID()}.tmp`; try { await writeFile(temp, JSON.stringify(campaign, null, 2) + "\n", "utf8"); beforeCommit?.(); await rename(temp, destination); } finally { await rm(temp, { force: true }); } }
  async read(id: string): Promise<CampaignRecord | null> { try { return JSON.parse(await readFile(this.path(id), "utf8")) as CampaignRecord; } catch { return null; } }
  async list(): Promise<CampaignRecord[]> { await mkdir(this.directory(), { recursive: true }); const names = (await readdir(this.directory())).filter((item) => item.endsWith(".json")); const entries = await Promise.all(names.map(async (name) => JSON.parse(await readFile(join(this.directory(), name), "utf8")) as CampaignRecord)); return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  private directory(): string { return join(this.root, "campaigns"); }
  private path(id: string): string { return join(this.directory(), `${id}.json`); }
}
