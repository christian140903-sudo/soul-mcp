# Contributing to Soul

Soul accepts small, evidence-backed changes that preserve user ownership,
provenance and upgrade safety.

## Development

```bash
git clone https://github.com/christian140903-sudo/soul-mcp.git
cd soul-mcp
npm ci
npm test
```

The test command builds TypeScript and executes the complete Node test suite.
Use an isolated `SOUL_DIR` for manual experiments; never run destructive tests
against `~/.soul`.

## Pull-request standard

1. Reproduce the problem or state the contract being added.
2. Add the smallest regression or contract test that proves the change.
3. Keep database migrations additive and write a verified backup before they
   run.
4. Document changes to storage, authority, network access, MCP contracts and
   backwards compatibility.
5. Run `npm test` and inspect `npm pack --dry-run`.
6. Remove secrets, personal memories and machine-specific paths.

## Claim policy

README and release claims are part of the product contract. Do not describe a
benchmark that has not run, a verifier that does not exist, or a safety
property that is only planned. Prefer a reproducible command, test or artifact
over an adjective.

## Design constraints

- local-first by default;
- one canonical SQLite database owned by the user;
- corrections supersede history instead of rewriting it silently;
- model output never gains user authority by implication;
- skills are declarative data and cannot grant rights;
- missing outcomes remain missing, not failures or successes.
