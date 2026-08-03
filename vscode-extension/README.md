# VS Code extension: NPM Docker Sync Tunnels

Share a local workspace port as a temporary NPMplus URL (Funnel-like UX).

## Prerequisites

1. `npm-docker-sync` running with:
   - `TUNNEL_BASE_DOMAIN` (e.g. `tunnels.example.com`)
   - `TUNNEL_FORWARD_HOST` or set `npmDockerSync.forwardHost` to your LAN/Tailscale IP
   - `WEB_UI_TOKEN` or `TUNNEL_API_TOKEN`
2. NPMplus must be able to reach that host:port (not outbound-only NAT punch-through).

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
- `npmDockerSync.forwardHost` — optional host override for tunnels

## Commands

- **NPM Docker Sync: Share Port…**
- **Copy Active Tunnel URL**
- **Stop Tunnel**
- **List Tunnels**
