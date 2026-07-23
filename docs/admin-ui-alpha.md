# RunForge Admin UI Alpha

RunForge Admin UI Alpha is a local-only operator console over existing RunForge files. It does not deploy, authenticate to a cloud service, call paid providers, apply patches, or mutate configured repositories.

## Config

The default user config path is:

```text
~/.runforge/config.json
```

Initialize it with:

```bash
pnpm dev admin config init
```

The MVP stores token references only. OpenRouter should be configured as an environment-variable reference:

```json
{
  "id": "openrouter",
  "type": "openrouter",
  "enabled": false,
  "apiKeyRef": "env:OPENROUTER_API_KEY",
  "defaultModel": null
}
```

Raw tokens are not written by the admin commands. Generated UI data redacts API keys, bearer tokens, OpenRouter key shapes, `.env`-style secret assignments, and private keys before writing `admin-data.json` or `index.html`.

## Commands

```bash
pnpm dev admin config show
pnpm dev admin repo add --id factory --name Factory --path /Users/evgeny/Documents/projects/factory --tag external
pnpm dev admin provider add-openrouter --api-key-ref env:OPENROUTER_API_KEY

For capped semantic campaigns, configure the server-only planner quote catalog before starting
the control plane: `RUNFORGE_OPENROUTER_MODEL_PRICING_JSON='{"provider/concrete-model":{"inputUsdPerToken":0.000001,"outputUsdPerToken":0.000002}}'`.
Each selected concrete planner model needs a positive input and output quote. Dynamic aliases
such as `openrouter/auto` are rejected for hard cost caps; request payloads cannot provide prices.
pnpm dev admin provider add-cli --id codex-cli --command codex
pnpm dev admin build --out /tmp/runforge-admin-ui
pnpm demo:admin-ui
```

The demo command writes a temporary config to `/tmp/runforge-admin-ui-config.json` and a static UI to:

```text
/tmp/runforge-admin-ui/index.html
```

## UI Scope

The static console includes:

- overview counts for repositories, providers, runs, outcomes, provider statuses, and operator-attention states;
- configured repository health with existence, git HEAD, dirty/clean status, tags, and last observed run;
- provider configuration with redacted token references and env-var present/missing status;
- run/evidence table with filters for repo, outcome, provider status, alpha, do_not_apply, verified proposals, and setup failures;
- packet detail sections that read `events.jsonl`, metrics, safety reports, setup policy, provider audit, proposal status, and manifest artifacts where present;
- settings showing config path, run roots, and redaction policy.

## Safety Boundaries

The Admin UI is read-only. It does not:

- mutate configured repositories;
- run code proposals;
- apply patches;
- call or test paid providers by default;
- write raw tokens;
- require internet access for normal operation;
- deploy anything.

Config CLI commands write only the local admin config selected by `--config` or the default `~/.runforge/config.json`.

## Known Limitations

File links use `file://` URLs, which some browsers restrict when opening static local HTML. The same paths are rendered as visible text.

Writable settings, path validation before save, and config diff preview are intentionally deferred to a later milestone.
