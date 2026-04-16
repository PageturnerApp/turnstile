# Security Policy

Turnstile is a self-hosted bridge that can expose direct download links. Treat the web UI, API keys, generated links, and connected indexers as private.

## Supported Versions

| Version | Supported |
| --- | --- |
| 1.x | Yes |

## Reporting a Vulnerability

Please do not open a public issue for vulnerabilities that expose credentials, bypass API-key authorization, allow path traversal, or leak files outside `DOWNLOADS_PATH`.

Report security issues by opening a private security advisory on GitHub, or by contacting the maintainers through the Pageturner project. Include:

- A clear description of the issue
- Steps to reproduce
- Expected and actual behavior
- Impact and affected versions
- Any relevant logs with secrets redacted

## Operational Guidance

- Keep `BRIDGE_URL` behind HTTPS.
- Complete first-run setup immediately after startup. Until `UI_PASSWORD_HASH` is set, anyone who can reach `/ui/setup` can create the UI password.
- Keep `BRIDGE_URL` accurate because Turnstile uses it as one of the trusted origins for UI state changes.
- Do not share API keys or generated `servedl` links.
- Treat query-string tokens as secrets because reverse proxies and access logs may record full URLs.
- Scope each API key to the narrowest useful categories, indexers, and downloads path.
- Keep `.env` private and never commit it.
- Rotate API keys and the UI password if seedbox credentials are shared or exposed.
