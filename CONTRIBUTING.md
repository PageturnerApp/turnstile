# Contributing

Thanks for helping make Turnstile better. Turnstile is part of the Pageturner project and is licensed under AGPL v3.

## Development

```bash
npm install
cp .env.example .env
npm test
node index.js
```

Use CommonJS throughout. Keep route handlers thin, and route all torrent-client operations through `services/torrentclient/index.js`.

## Code Standards

- Add the project license header to source files.
- Use the logger utility instead of raw console calls.
- Keep functions documented with JSDoc.
- Return the standard API response envelope for JSON API errors and success responses.
- Keep error messages user-friendly.
- Avoid committing `.env`, logs, downloaded files, generated tarballs, or seedbox-specific config.

## Pull Requests

Before opening a PR:

```bash
npm test
npm audit --omit=dev
npm pack --dry-run
```

Open an issue before starting large changes, especially new torrent-client adapters or API contract changes.
