import { describe, expect, it } from "vitest";
import { projectCampaignValidation } from "../../src/control-plane/campaign-child-projection.js";

describe("campaign child projection", () => {
  it("preserves Docker capability metadata while making a campaign-required command strict", () => {
    const command = "docker compose run --rm checks";
    const taskSpec: Record<string, any> = {
      execution: { mode: "implementation" },
      validation: {
        mode: "explicit",
        commands: [command],
        requirements: [{ command, capabilities: ["docker", "network"], acceptance: "advisory", evidenceRole: "docker-denied-evidence", fallbacks: ["Attach denied-capability evidence"], source: "explicit" }],
        projectPolicy: { deniedCapabilities: ["docker", "network"] },
      },
    };
    const campaign = { spec: { validationContract: { requiredCommands: [command] } } } as any;
    const node = { id: "implementation", dependsOn: [], taskSpec } as any;

    projectCampaignValidation(taskSpec, campaign, node);

    expect(taskSpec.validation.requirements).toEqual([{
      command, capabilities: ["docker", "network"], acceptance: "required", evidenceRole: "docker-denied-evidence",
      fallbacks: ["Attach denied-capability evidence"], source: "explicit",
    }]);
    expect(taskSpec.validation.projectPolicy).toEqual({ deniedCapabilities: ["docker", "network"] });
  });
});
