# VS Code extension: NPM Docker Sync Tunnels

Share a local workspace port as a temporary NPMplus URL (Funnel-like UX).

## Prerequisites

1. `npm-docker-sync` running with:
   - `TUNNEL_BASE_DOMAIN` (e.g. `tunnels.example.com`)
   - **TLS**: `TUNNEL_CERTIFICATE_ID` (or a wildcard cert / `CERT_DOMAIN_MAP` covering that base). Without a cert, HTTPS tunnels fail with `ERR_SSL_VERSION_OR_CIPHER_MISMATCH`.
   - `WEB_UI_TOKEN` or `TUNNEL_API_TOKEN`
2. NPMplus must reach your machine on the chosen port (same LAN or Tailscale).

The extension **auto-detects your machine’s IPv4** (prefers Tailscale `100.x`, then LAN) and sends it as the tunnel forward host. Optional override: `npmDockerSync.forwardHost`.

## Install (dev)

```bash
cd vscode-extension
npm install
npm run compile
```

In VS Code: **Extensions: Install from Location…** → select this folder, or use F5 to launch an Extension Development Host.

## Settings

- `npmDockerSync.url` — API base (default `http://localhost:8080`)
- `npmDockerSync.token` — bearer token
- `npmDockerSync.forwardHost` — optional IP override (otherwise auto-detected)

## Commands

- **NPM Docker Sync: Share Port…** — picks from listening/common ports or a custom port; default name is the workspace folder; hostname becomes `{name}-{id}.{TUNNEL_BASE_DOMAIN}`
- **Copy Active Tunnel URL**
- **Stop Tunnel**
- **List Tunnels**
