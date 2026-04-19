<p align="center">
  <img src="public/ui/turnstile-logo.png" alt="Turnstile logo" width="180">
</p>

<div align="center">

# Turnstile

### A self-hosted download provider bridge for [Pageturner](https://getpageturner.com) and other apps

[![CI](https://github.com/PageturnerApp/turnstile/actions/workflows/ci.yml/badge.svg)](https://github.com/PageturnerApp/turnstile/actions/workflows/ci.yml)
[![Release](https://github.com/PageturnerApp/turnstile/actions/workflows/release.yml/badge.svg)](https://github.com/PageturnerApp/turnstile/actions/workflows/release.yml)
[![License: AGPL v3](https://img.shields.io/github/license/PageturnerApp/turnstile?color=3A9E6B)](LICENSE)
[![Node.js >=18](https://img.shields.io/badge/node-%3E%3D18-3A9E6B)](package.json)
[![Docker ready](https://img.shields.io/badge/docker-ready-3A9E6B)](Dockerfile)
[![CommonJS](https://img.shields.io/badge/modules-commonjs-3A9E6B)](package.json)
[![Prowlarr bridge](https://img.shields.io/badge/prowlarr-bridge-3A9E6B)](#what-is-turnstile)

Part of the [Pageturner](https://getpageturner.com) project · AGPL v3

</div>

## What is Turnstile?

Turnstile lets Pageturner, and any other app that speaks its open API, use your private trackers and public indexers as download sources through your own seedbox. It wraps Prowlarr and your torrent client in a clean authenticated bridge that feels like a normal download provider to the apps you connect. Single-file downloads are served directly, while multi-file folders such as MP3 audiobooks are streamed as one `.zip` archive.

## Supported torrent clients

- qBittorrent
- Deluge
- Transmission
- rTorrent / ruTorrent

## Compatible apps

Turnstile is built for Pageturner first, but its API is open so other apps can integrate too. If you are adding support in another app, open an issue or PR and we will help keep the bridge friendly to shared use.

## Prerequisites

- Seedbox or server with SSH access
- Prowlarr installed with at least one indexer configured
- One of the supported torrent clients installed and set as a download client in Prowlarr
- Node.js v18+

## Installation — Ultra.cc

⚠️ This is an unofficial installation guide for Ultra.cc.
Ultra.cc staff cannot provide support for Turnstile.
Use at your own risk and only if you are comfortable troubleshooting.

### Step 1 — Connect via SSH

```bash
# See: https://docs.ultra.cc/connection-details/ssh/connect-to-your-ultra-slot-via-ssh
```

### Step 2 — Find an available port

```bash
app-ports free
# Note an unused port — use this instead of the default 7878
# Do NOT use ports outside your assigned range
```

Use `app-ports show` to see ports already allocated to Prowlarr, Deluge, qBittorrent, or Transmission.

### Step 3 — Install Node.js

```bash
# https://docs.ultra.cc/unofficial-language-installers/install-node-js
node --version  # must be v18+
```

### Step 4 — Clone Turnstile

```bash
cd ~
git clone https://github.com/PageturnerApp/turnstile
cd turnstile
```

### Step 5 — Install dependencies

```bash
npm install
```

### Step 6 — Configure

```bash
cp .env.example .env
nano .env
```

Fill in `PROWLARR_URL`, `PROWLARR_API_KEY`, `TORRENT_CLIENT`, `TORRENT_CLIENT_URL`, `TORRENT_CLIENT_USER`, `TORRENT_CLIENT_PASS`, `DOWNLOADS_PATH`. Set `PORT` to your assigned port. Leave `BRIDGE_URL` for now — you will set it after Step 9.

On Ultra.cc, Prowlarr usually runs behind its base path. If `app-ports show` says Prowlarr is on port `13374`, use:

```env
PROWLARR_URL=http://127.0.0.1:13374/prowlarr
```

For Deluge, `TORRENT_CLIENT_URL` must point at Deluge Web JSON-RPC, not the daemon port. On Ultra.cc this is commonly a local URL like `http://127.0.0.1:13355`, but it can also be an HTTPS reverse-proxy URL on port 443 such as `https://username.hostname.usbx.me/deluge`.

Press `CTRL+X`, `Y`, `ENTER` to save.

### Step 7 — Run once to verify

```bash
node index.js
# Should print: Turnstile is running - Complete setup at: http://localhost:PORT/ui
# Press CTRL+C to stop
```

### Step 8 — Create systemd service

```bash
mkdir -p ~/.config/systemd/user
nano ~/.config/systemd/user/turnstile.service
```

Paste the following, replacing `YOUR_NODE_PATH` (run `which node` to find it):

```ini
[Unit]
Description=Turnstile - Pageturner self-hosted download bridge
After=network-online.target

[Service]
Type=exec
Restart=on-failure
WorkingDirectory=%h/turnstile
ExecStart=YOUR_NODE_PATH %h/turnstile/index.js
ExecStop=/bin/kill -s QUIT $MAINPID
StandardOutput=append:%h/logs/turnstile.log
StandardError=append:%h/logs/turnstile.log

[Install]
WantedBy=default.target
```

```bash
mkdir -p ~/logs
systemctl --user daemon-reload
systemctl --user enable --now turnstile.service
systemctl --user status turnstile.service
# Should show: Active: active (running)
```

If Node 22 exits with an Undici `WebAssembly.instantiate()` memory error, edit `ExecStart` to disable Node's built-in fetch implementation:

```ini
ExecStart=YOUR_NODE_PATH --no-experimental-fetch %h/turnstile/index.js
```

### Step 9 — Enable HTTPS via Nginx

```bash
touch ~/.apps/nginx/proxy.d/turnstile.conf
nano ~/.apps/nginx/proxy.d/turnstile.conf
```

Paste, replacing `YOUR_PORT`:

```nginx
location = /turnstile {
    return 301 /turnstile/;
}

location /turnstile/ {
    proxy_pass              http://127.0.0.1:YOUR_PORT/;
    proxy_http_version      1.1;
    proxy_set_header        Host              $host;
    proxy_set_header        X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header        X-Forwarded-Host  $host;
    proxy_set_header        X-Forwarded-Proto https;
    proxy_set_header        X-Forwarded-Prefix /turnstile;
    proxy_redirect          off;
}
```

```bash
app-nginx restart
```

Turnstile is now available at:

```text
https://username.hostname.usbx.me/turnstile/ui
```

### Step 10 — Update BRIDGE_URL

```bash
nano ~/turnstile/.env
# Set BRIDGE_URL=https://username.hostname.usbx.me/turnstile
systemctl --user restart turnstile.service
```

### Step 11 — Complete setup in the UI

- Visit `https://username.hostname.usbx.me/turnstile/ui`
- Set your UI password
- Create your first API key
- Copy the API key — it will only be shown once

### Step 12 — Connect to Pageturner

- Open Pageturner → Sources → Add Download Provider → Self-Hosted
- Bridge URL: `https://username.hostname.usbx.me/turnstile`
- API Key: paste from Step 11

## Updating

The top-right version pill checks the latest GitHub Release and turns red when an update is available. Hover or focus the version pill to see release notes and manual update commands. Turnstile never silently pulls code or restarts itself.

### Bare Node / Ultra.cc

```bash
cd ~/turnstile
git fetch --tags
git checkout v1.0.1
npm install --omit=dev
systemctl --user restart turnstile.service
```

Replace `v1.0.1` with the release shown in the version pill or on the [releases page](https://github.com/PageturnerApp/turnstile/releases).

If your service uses the Node 22 workaround from Step 8, keep the `--no-experimental-fetch` flag after updating.

### Docker

```bash
cd ~/turnstile
docker compose pull
docker compose up -d
```

## Installation — Docker

```bash
git clone https://github.com/PageturnerApp/turnstile
cd turnstile
cp .env.example .env
nano .env  # fill in your config
docker compose up -d
# Visit http://your-server-ip:7878/ui to complete setup
```

For Docker installs, set `DOWNLOADS_PATH=/downloads` in `.env`. The compose file mounts `/home/user/downloads` on the host to `/downloads` inside the container; change the left side of that volume to your real host downloads folder.

The default compose file uses the published image at `ghcr.io/pageturnerapp/turnstile:latest`. To build locally instead, replace the `image` line with `build: .`.

## Installation — Bare Node

```bash
git clone https://github.com/PageturnerApp/turnstile
cd turnstile
npm install
cp .env.example .env
nano .env  # fill in your config
node index.js
```

## Config reference

| Variable | Description | Default | Example |
| --- | --- | --- | --- |
| `PROWLARR_URL` | Base URL for Prowlarr, including reverse-proxy base path if used. | `http://localhost:9696` | `https://host.example/prowlarr` |
| `PROWLARR_API_KEY` | Prowlarr API key from Settings → General. | empty | `abc123` |
| `TORRENT_CLIENT` | Torrent adapter type. Accepted values: `qbittorrent`, `deluge`, `transmission`, `rtorrent`. | `qbittorrent` | `deluge` |
| `TORRENT_CLIENT_URL` | Web/API URL for the torrent client. Include the port and any reverse-proxy base path. For Deluge, use Deluge Web JSON-RPC, not the daemon port. | `http://localhost:8080` | `https://host.example:443/deluge` |
| `TORRENT_CLIENT_USER` | Torrent client username where applicable. | `admin` | `seedboxuser` |
| `TORRENT_CLIENT_PASS` | Torrent client password. | `adminpass` | `correct-horse-battery-staple` |
| `DOWNLOADS_PATH` | Global root folder for served downloads. | `/home/user/downloads` | `/home/user/downloads` |
| `BRIDGE_URL` | Public URL clients use to call Turnstile. | `http://your-seedbox-ip:7878` | `https://username.hostname.usbx.me/turnstile` |
| `PORT` | Turnstile HTTP port. | `7878` | `12345` |
| `API_KEYS` | JSON-stringified API key array managed by the UI. | `[]` | `[]` |
| `UI_PASSWORD_HASH` | Bcrypt hash created by first-run setup. | empty | `$2b$12$...` |
| `SESSION_SECRET` | Auto-generated session signing secret that keeps UI logins valid across restarts. | empty | `64-character hex string` |

## Common Prowlarr category IDs

```text
3030 / 3040   Audiobooks
7000 / 7020   Ebooks
2000          Movies
5000          TV
```

## API reference

Every JSON API response uses:

```json
{
  "success": true,
  "detail": "Human readable message safe to show users.",
  "data": {}
}
```

API key auth accepts `?token=API_KEY` or `Authorization: Bearer API_KEY`.

### Health

```bash
curl http://localhost:7878/api/v1/health
```

### Search

```bash
curl "http://localhost:7878/api/v1/search?token=API_KEY&q=Book%20Title&limit=10"
```

### Create torrent

```bash
curl -X POST "http://localhost:7878/api/v1/torrents/createtorrent?token=API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"magnet":"https://localhost:9696/api/v1/indexer/1/download?link=...","name":"Book Title"}'
```

### Add by infohash

```bash
curl -X POST "http://localhost:7878/api/v1/torrents/addhash?token=API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"infohash":"0123456789abcdef0123456789abcdef01234567","name":"Book Title"}'
```

### Poll torrent status

```bash
curl "http://localhost:7878/api/v1/torrents/mylist?token=API_KEY&id=TORRENT_HASH"
```

### Request a direct download link

```bash
curl "http://localhost:7878/api/v1/torrents/requestdl?token=API_KEY&torrent_id=TORRENT_HASH"
```

### Serve a direct download

```bash
curl -OJ "http://localhost:7878/api/v1/torrents/servedl?token=API_KEY&file=relative%2Fpath%2Ffile.epub"
```

`file` can point to a file or a folder path relative to the global `DOWNLOADS_PATH`.

### UI config

Requires an authenticated UI session.

```bash
curl -b cookie.txt "http://localhost:7878/api/v1/config"
curl -X POST -b cookie.txt "http://localhost:7878/api/v1/config" \
  -H "Content-Type: application/json" \
  -d '{"bridgeUrl":"https://example.com/turnstile","downloadsPath":"/home/user/downloads","port":7878}'
```

### API keys

Requires an authenticated UI session.

```bash
curl -b cookie.txt "http://localhost:7878/api/v1/keys"
curl -X POST -b cookie.txt "http://localhost:7878/api/v1/keys" \
  -H "Content-Type: application/json" \
  -d '{"name":"KOReader","categories":[7000,7020],"indexers":[],"downloads_path":"/home/user/downloads/ebooks"}'
curl -X PUT -b cookie.txt "http://localhost:7878/api/v1/keys/KEY_ID" \
  -H "Content-Type: application/json" \
  -d '{"name":"Pageturner","categories":[3030,3040],"indexers":["MyAnonamouse"],"downloads_path":"/home/user/downloads/audiobooks"}'
curl -X DELETE -b cookie.txt "http://localhost:7878/api/v1/keys/KEY_ID"
```

### Update status

Requires an authenticated UI session.

```bash
curl -b cookie.txt "http://localhost:7878/api/v1/update"
```

This checks the latest GitHub Release, returns the installed version, and provides manual update commands for Bare Node and Docker installs.

## Download behavior

Turnstile always gives clients one download URL, even when the finished torrent contains multiple files:

- `/search` prepends local cached matches before remote Prowlarr results.
- `/torrents/createtorrent` re-checks the local cache before queueing a selected remote result, using normalized title matching to avoid re-adding something that is already downloaded.
- If the target resolves to a single file, Turnstile serves that file directly with its original filename.
- If the target resolves to a folder containing exactly one file, Turnstile serves the contained file directly.
- If the target resolves to a folder containing multiple files, Turnstile streams that folder as a `.zip` archive.
- ZIP archives are generated on demand and streamed to the client. Turnstile does not create temporary archive files on disk.
- Folder archives preserve the top-level folder name, which keeps multi-part audiobooks and similar downloads grouped after extraction.

This means `.m4b`, `.epub`, `.pdf`, and other single-file downloads stay direct, while multi-file MP3 audiobooks download as one archive.

## Architecture notes

Turnstile never calls torrent clients from routes directly. Routes use `services/torrentclient/index.js`, which returns the configured adapter. Each adapter implements `addMagnet`, `getTorrent`, `getRecentlyAdded`, and `authenticate`, and maps native client state into Turnstile's normalized torrent shape.

Local cache lookup and direct downloads are handled separately from torrent-client adapters. `services/localfiles.js` resolves local download targets under `DOWNLOADS_PATH`, and `services/zipstream.js` streams multi-file folders as ZIP archives without adding external archive dependencies.

## Security notes

- Complete first-run setup immediately after starting Turnstile. Until `UI_PASSWORD_HASH` is set, anyone who can reach `/ui/setup` can create the UI password.
- Put public installs behind HTTPS and set `BRIDGE_URL` to the HTTPS URL clients will use.
- The UI uses bcrypt password hashing, HTTP-only signed session cookies, session regeneration after login, same-origin checks for UI mutations, and in-memory rate limiting for login/setup attempts.
- API keys are bearer secrets. Query-string tokens are supported for TorBox-compatible clients, but reverse proxies and access logs may record URLs, so keep logs private and rotate exposed keys.
- Generated download links are authenticated but should still be treated as private.
- `servedl` resolves files and zip archive contents under the global `DOWNLOADS_PATH` root and rejects traversal outside that root.
- Turnstile is intended for personal self-hosted use. Do not resell API keys, public download links, or access to a seedbox unless your infrastructure provider and every connected indexer/tracker explicitly allow that use.

## Seeding, ratio, and tracker rules

Turnstile is designed to stay out of the way of your existing Prowlarr and torrent-client seeding policy.

When a download comes from a Prowlarr search result, Turnstile asks Prowlarr to grab the result. Prowlarr then sends it to the download client using the download-client configuration you already set up in Prowlarr. That means Turnstile does not override Prowlarr categories, labels, client mappings, ratio limits, seeding time limits, queue policy, or tracker-specific behavior.

When a download is added directly with `/api/v1/torrents/addhash`, a magnet link, or a direct torrent URL, Turnstile bypasses Prowlarr and sends it straight to the selected torrent client. In that path Turnstile sets the save path, and the torrent client's global defaults apply. Prowlarr-specific labels or category rules do not apply to direct adds.

For private trackers, configure ratio and seed-time rules in Prowlarr and your torrent client. Turnstile will not intentionally shorten seeding, pause torrents, remove torrents, or bypass your existing tracker rules.

State is file-backed and stateless at runtime:

- No database
- API keys stored as a JSON-stringified array in `API_KEYS`
- UI password stored as a bcrypt hash in `UI_PASSWORD_HASH`
- UI session signing secret stored in `SESSION_SECRET`
- Settings changes rewrite `.env` and reload in memory

## Release checklist

Before publishing or tagging a release:

```bash
npm ci
npm test
npm audit --omit=dev
npm pack --dry-run
```

Confirm the package output does not include `.env`, logs, downloaded files, or seedbox-specific configuration.

## Release process

Turnstile releases are tag-driven. Publishing a tag like `v1.0.1` runs the release workflow, repeats the verification checks on Node 18, 20, and 22, validates that the tag matches `package.json`, publishes a Docker image to GitHub Container Registry, and creates a GitHub Release with generated notes.

For the first public release, create the `v1.0.0` tag from a clean `main` branch:

```bash
git checkout main
git pull
git tag v1.0.0
git push origin main --tags
```

For later patch releases:

```bash
git checkout main
git pull
npm version patch
git push origin main --tags
```

Use `npm version minor` or `npm version major` when the change warrants it. Published Docker images use these tags:

```text
ghcr.io/pageturnerapp/turnstile:v1.0.1
ghcr.io/pageturnerapp/turnstile:latest
```

After the first image is published, confirm the GitHub Container Registry package is public so Docker users can pull it without logging in.

The in-app update checker only reads public GitHub Release metadata. It does not install updates, write files, run git commands, or restart Turnstile.

## Contributing

Issues and PRs welcome. Please open an issue before starting large changes. All contributions are subject to AGPL v3.

## Disclaimer

⚠️ Turnstile is for personal use only. Do not share your API keys
or generated download links with others. You are responsible for
ensuring your use of Turnstile and any connected indexers complies
with their rules and all applicable laws.
