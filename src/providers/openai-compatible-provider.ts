import type { TriageProvider, TriageProviderInput, TriageProviderOutput } from "./provider.js";

export class OpenAICompatibleProvider implements TriageProvider {
  name = "openai-compatible";

  constructor(private readonly model?: string) {}

  async summarize(input: TriageProviderInput): Promise<TriageProviderOutput> {
    if (!process.env.OPENAI_API_KEY && !process.env.OPENAI_COMPATIBLE_API_KEY) {
      return {
        review: {
          ...input.review,
          risks: [...input.review.risks, "OpenAI-compatible provider was requested without an API key; heuristics were used."]
        }
      };
    }
    return {
      review: {
        ...input.review,
        followUp: [...input.review.followUp, `Provider skeleton selected for model ${this.model ?? "unspecified"}.`]
      }
    };
  }
}
