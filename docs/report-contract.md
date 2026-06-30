# Report contract

`review.md` is the primary product artifact.

It must include:

- Verdict with category, root cause, confidence, and human decision flag.
- Summary.
- Evidence from logs, relevant files, and package scripts.
- Checked and not checked sections.
- A safe next command or an explicit explanation that none was found.
- Risks and suggested follow-up.

Confidence must be one of `low`, `medium`, or `high`.

The report must never claim that a command was run if RunForge only suggested it.
