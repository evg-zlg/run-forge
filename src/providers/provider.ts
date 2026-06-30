import type { ReviewModel } from "../core/types.js";

export interface TriageProviderInput {
  review: ReviewModel;
}

export interface TriageProviderOutput {
  review: ReviewModel;
}

export interface TriageProvider {
  name: string;
  summarize(input: TriageProviderInput): Promise<TriageProviderOutput>;
}
