import type { TriageProvider, TriageProviderInput, TriageProviderOutput } from "./provider.js";

export class MockProvider implements TriageProvider {
  name = "mock";

  async summarize(input: TriageProviderInput): Promise<TriageProviderOutput> {
    return { review: input.review };
  }
}
