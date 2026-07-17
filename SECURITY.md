# Security policy

Soul stores personal context, so security reports deserve a private channel.

## Supported versions

Only the latest published 4.x release receives security fixes. Upgrade before
reporting unless the issue prevents an upgrade.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/christian140903-sudo/soul-mcp/security/advisories/new).
Do not open a public issue and do not attach a real Soul database, passport,
secret, private prompt or identifying memory content.

Please include:

- the Soul and Node versions;
- the smallest sanitized reproduction;
- the affected trust boundary or data path;
- whether local code execution, filesystem access or a malicious MCP client is
  required;
- any mitigation you already tested.

## Security boundaries

Soul is local-first and makes no background network calls. The optional
semantic layer downloads its npm dependency and embedding model only when the
operator explicitly runs `soul-mcp semantic on`. Soul does not sandbox the
host OS, the MCP client or other local processes that can already read the
user account. See [the threat model](docs/THREAT-MODEL.md) for the complete
scope and invariants.
