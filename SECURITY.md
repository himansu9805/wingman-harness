# Security Policy

## Supported versions

Wingman Harness is under active development and has no published releases.
Security fixes target the latest `main` branch. Older commits and forks do not
receive separate security updates.

## Reporting a vulnerability

Please keep vulnerability details out of public issues, pull requests, and
discussions until a fix or coordinated disclosure is available.

Use GitHub's [private vulnerability reporting form](https://github.com/himansu9805/wingman-harness/security/advisories/new)
when it is available. Private vulnerability reporting is not currently enabled
for this repository. If the form is unavailable, open an
[issue](https://github.com/himansu9805/wingman-harness/issues/new) titled
**Request a private security reporting channel**, without including the
vulnerability, exploit, affected endpoint, credentials, or other sensitive
details. The maintainer can then arrange a private reporting channel.

Once a private channel is available, include:

- The affected commit, component, and relevant configuration.
- A description of the vulnerability, its prerequisites, and potential impact.
- Minimal reproduction steps or a proof of concept using test data.
- Relevant logs with tokens, credentials, and personal information removed.
- Any proposed mitigation or fix, if known.

Test only systems and data you own or are authorized to assess. Do not include
live credentials or unrelated private data in a report.

## Handling and disclosure

Reports are handled on a best-effort basis by the project maintainer; there is
no guaranteed response or remediation timeline. The maintainer may request
more information, validate the impact, and coordinate a fix and disclosure
with the reporter. Please coordinate before publishing exploit details.

## Deployment and trust boundaries

Wingman can execute commands with the permissions of the account running it.
Command approval is not an operating-system sandbox. Run it with only the
access needed for your work, and review commands before approving them.

The HTTP server binds to `127.0.0.1` by default and uses a shared bearer token.
It does not provide per-user or per-tenant isolation. Network exposure requires
appropriate authentication, access controls, and TLS.

MCP servers and locally installed skills are trusted integrations. MCP tools
do not pass through the built-in shell command approval flow. Review the
servers and skills you configure, and protect model credentials, the API token,
PostgreSQL data, and the local memory database.

Authentication bypasses, shell approval bypasses, unintended command execution,
and unauthorized access to conversations, memory, or credentials are relevant
security concerns. These deployment assumptions do not rule out reports of
vulnerabilities in the implemented controls.

See [Command Approval and Security](https://github.com/himansu9805/wingman-harness/wiki/Command-Approval-and-Security)
for detailed operating guidance.

## Automated checks

GitHub Actions runs Snyk dependency scanning and Semgrep code and secret-pattern
scanning. Their results help identify issues but do not guarantee that the
application or its dependencies are free of vulnerabilities.
