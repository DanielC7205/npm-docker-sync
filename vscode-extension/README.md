# VS Code extension: NPM Docker Sync Tunnels

Share a local workspace port as a temporary NPMplus URL (Funnel-like UX).

## Prerequisites

1. `npm-docker-sync` running with:
   - `TUNNEL_BASE_DOMAIN` (e.g. `tunnels.example.com`)
   - `TUNNEL_FORWARD_HOST` — IP/hostname **NPMplus can reach** for your machine (LAN or Tailscale). On Docker Desktop with NPM on the same host, `host.docker.internal` is used as a last resort.
   - `WEB_UI_TOKEN` or `TUNNEL_API_TOKEN`
2. NPMplus must be able to reach that host:port (not outbound-only NAT punch-through).

### Why `TUNNEL_FORWARD_HOST (or host override) is required`

Tunnels are reverse proxies: NPMplus dials **your** machine. The API therefore needs a reachable forward host. Set it in:

- Web UI **Settings → Dev tunnels → Forward host**, or
- Extension setting `npmDockerSync.forwardHost`, or
- When sharing a port, enter it when prompted (and optionally save it).

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
- `npmDockerSync.forwardHost` — host NPMplus dials (LAN/Tailscale IP)

## Commands

- **NPM Docker Sync: Share Port…** — picks from listening/common ports or a custom port; default name is the workspace folder; hostname becomes `{name}-{id}.{TUNNEL_BASE_DOMAIN}`
- **Copy Active Tunnel URL**
- **Stop Tunnel**
- **List Tunnels**
