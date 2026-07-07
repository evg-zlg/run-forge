export type HandoffArchiveFormat = "json" | "md" | "table";

export interface HandoffArchiveOptions {
  root: string;
  out?: string;
}

export interface HandoffArchiveSearchFilters {
  repo?: string;
  decision?: string;
  auditStatus?: string;
  safetyStatus?: string;
  validationStatus?: string;
  originalMutated?: string;
}

export interface HandoffArchiveSearchOptions {
  archive: string;
  out?: string;
  format?: HandoffArchiveFormat;
  filters?: HandoffArchiveSearchFilters;
}

export interface HandoffArchiveRecord {
  id: string;
  repoPath: string;
  repoName: string;
  handoffPath: string;
  handoffReadmePath: string;
  patchPath: string;
  auditResultPath: string;
  auditReportPath: string;
  decisionPath: string;
  operatorSummaryPath: string;
  lifecycleReportPath: string;
  auditStatus: string;
  decisionVerdict: string;
  validationBefore: string;
  validationAfter: string;
  originalRepoMutated: boolean;
  safetyStatus: "safe" | "unsafe" | "unknown";
  unsafeReasons: string[];
  lifecycleRefs: string[];
  validationCommands: string[];
  createdFromAlpha: string;
  findings: string[];
  recommendations: string[];
}

export interface HandoffArchiveCounts {
  records: number;
  byRepo: Record<string, number>;
  byDecision: Record<string, number>;
  byAuditStatus: Record<string, number>;
  bySafetyStatus: Record<string, number>;
  byValidationAfter: Record<string, number>;
}

export interface HandoffArchiveValidationResult {
  passed: boolean;
  errors: string[];
}

export interface HandoffArchiveResult {
  schemaVersion: "alpha-26-handoff-archive";
  generatedAt: string;
  root: string;
  records: HandoffArchiveRecord[];
  counts: HandoffArchiveCounts;
  findings: string[];
  recommendations: string[];
  validation: HandoffArchiveValidationResult;
}

export interface HandoffArchiveSearchResult {
  schemaVersion: "alpha-26-handoff-search";
  generatedAt: string;
  archivePath: string;
  matchingCount: number;
  filters: HandoffArchiveSearchFilters;
  records: HandoffArchiveRecord[];
}
