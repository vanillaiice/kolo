# Migration references

`legacy-go/` preserves the previous server, migrations, tests, and work in progress.
Its Go module path is unchanged; explicit Go checks can still resolve imports.
Active npm checks exclude it. `legacy-mobile/package-lock.json` preserves the prior
mobile resolution; only root `package-lock.json` is used by active installation.

Keep references while porting rules and fixtures. Do not treat the Nest scaffold as
equivalent to the old server. Retirement requires the parity/cutover gates and an
explicit decision.
