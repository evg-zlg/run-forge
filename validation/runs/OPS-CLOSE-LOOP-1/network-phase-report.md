# Network phase report

## Classification

No dependency or runtime phase used network access.

| Phase | Command class | Network policy | Result |
| --- | --- | --- | --- |
| Git/GitHub control plane | fetch, push, PR creation/status | network allowed, publication-only | succeeded |
| Dependency preparation | `npm ci --offline --ignore-scripts` | OS network denied plus npm offline mode | succeeded from local cache |
| Targeted runtime validation | Node assertion and ESLint | OS network denied | passed |
| Test runtime | Vitest | OS network denied | 181 passed |
| Lint runtime | ESLint | OS network denied | passed |
| Build runtime, default | Next/Turbopack | OS network denied | blocked by attempted local port bind; no registry access |
| Build runtime, fallback | Next/webpack | OS network denied | passed |

The macOS sandbox profile was `(version 1)(allow default)(deny network*)`. The default Turbopack builder's local bind was correctly denied and classified as an environment/tooling limitation. The webpack build provided equivalent production compilation coverage without relaxing the network policy.

Registry contact observed: **none**. Network-enabled dependency preparation: **none**. Provenance: packages came from the pre-existing local npm cache under `npm ci --offline`.
