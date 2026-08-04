import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

interface TunnelResponse {
  id: string;
  url: string;
  expiresAt: string;
  domain?: string;
  slug?: string;
}

let activeTunnel: TunnelResponse | null = null;
let statusBar: vscode.StatusBarItem | undefined;

export function activate(context: vscode.ExtensionContext) {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'npmDockerSync.copyUrl';
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('npmDockerSync.sharePort', sharePort),
    vscode.commands.registerCommand('npmDockerSync.copyUrl', copyUrl),
    vscode.commands.registerCommand('npmDockerSync.stopTunnel', stopTunnel),
    vscode.commands.registerCommand('npmDockerSync.listTunnels', listTunnels),
  );
}

export async function deactivate() {
  if (activeTunnel) {
    try {
      await api(`/api/tunnels/${activeTunnel.id}`, { method: 'DELETE' });
    } catch {
      // ignore
    }
  }
}

function workspaceLabel(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return 'dev';
  return folder.name || path.basename(folder.uri.fsPath);
}

async function detectListeningPorts(): Promise<number[]> {
  const found = new Set<number>();

  // Common Vite/Next/etc. ports as soft suggestions
  for (const p of [3000, 3001, 5173, 5174, 8080, 8000, 4200, 5000, 4321, 4000, 9229]) {
    found.add(p);
  }

  try {
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const { stdout } = await execFileAsync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], {
        timeout: 3000,
        maxBuffer: 2 * 1024 * 1024,
      });
      for (const line of stdout.split('\n')) {
        const m = line.match(/:(\d+)\s+\(LISTEN\)/);
        if (m) {
          const port = Number(m[1]);
          if (port > 0 && port < 65536) found.add(port);
        }
      }
    } else if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('netstat', ['-an'], {
        timeout: 3000,
        maxBuffer: 2 * 1024 * 1024,
      });
      for (const line of stdout.split('\n')) {
        if (!/LISTEN/i.test(line)) continue;
        const m = line.match(/:(\d+)\s/);
        if (m) {
          const port = Number(m[1]);
          if (port > 1024 && port < 65536) found.add(port);
        }
      }
    }
  } catch {
    // fall back to common ports only
  }

  return [...found].sort((a, b) => a - b);
}

async function sharePort() {
  const detected = await detectListeningPorts();
  const project = workspaceLabel();

  const picks: vscode.QuickPickItem[] = [
    ...detected.slice(0, 40).map((p) => ({
      label: `$(radio-tower) ${p}`,
      description: 'Detected / common',
      detail: String(p),
    })),
    {
      label: '$(edit) Enter a custom port…',
      description: 'Type any port',
      detail: '__custom__',
    },
  ];

  const chosen = await vscode.window.showQuickPick(picks, {
    placeHolder: `Share a port for “${project}”`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!chosen) return;

  let portStr: string | undefined;
  if (chosen.detail === '__custom__') {
    portStr = await vscode.window.showInputBox({
      prompt: 'Local port to share',
      value: '3000',
      validateInput: (v) =>
        /^\d+$/.test(v) && Number(v) > 0 && Number(v) < 65536 ? undefined : 'Enter a valid port',
    });
  } else {
    portStr = chosen.detail;
  }
  if (!portStr) return;

  const label = await vscode.window.showInputBox({
    prompt: 'Tunnel name (used in the hostname)',
    value: project,
    placeHolder: project,
  });
  if (label === undefined) return;

  const cfg = vscode.workspace.getConfiguration('npmDockerSync');
  let host = (cfg.get<string>('forwardHost') || '').trim() || undefined;

  if (!host) {
    const hostPick = await vscode.window.showInputBox({
      prompt:
        'Host NPMplus should dial (LAN/Tailscale IP). Leave empty to use server TUNNEL_FORWARD_HOST / host.docker.internal.',
      placeHolder: '100.x.y.z or 192.168.x.x',
      ignoreFocusOut: true,
    });
    if (hostPick === undefined) return;
    host = hostPick.trim() || undefined;
    if (host) {
      const save = await vscode.window.showQuickPick(['Save as extension setting', 'Use once'], {
        placeHolder: `Remember ${host}?`,
      });
      if (save === 'Save as extension setting') {
        await cfg.update('forwardHost', host, vscode.ConfigurationTarget.Global);
      }
    }
  }

  try {
    const tunnel = await api<TunnelResponse>('/api/tunnels', {
      method: 'POST',
      body: JSON.stringify({
        port: Number(portStr),
        label: (label || project).trim() || undefined,
        host,
      }),
    });
    activeTunnel = tunnel;
    await vscode.env.clipboard.writeText(tunnel.url);
    updateStatus(tunnel);
    const pick = await vscode.window.showInformationMessage(
      `Tunnel ready: ${tunnel.url} (copied)`,
      'Copy again',
      'Stop',
    );
    if (pick === 'Copy again') {
      await vscode.env.clipboard.writeText(tunnel.url);
    } else if (pick === 'Stop') {
      await stopTunnel();
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(
      `Tunnel failed: ${msg}` +
        (msg.includes('TUNNEL_FORWARD_HOST')
          ? ' Set Settings → Dev tunnels → Forward host, or npmDockerSync.forwardHost.'
          : ''),
    );
  }
}

async function copyUrl() {
  if (!activeTunnel) {
    vscode.window.showWarningMessage('No active tunnel in this session');
    return;
  }
  await vscode.env.clipboard.writeText(activeTunnel.url);
  vscode.window.showInformationMessage(`Copied ${activeTunnel.url}`);
}

async function stopTunnel() {
  if (!activeTunnel) {
    const tunnels = await api<Array<{ id: string; url: string }>>('/api/tunnels');
    if (!tunnels.length) {
      vscode.window.showInformationMessage('No tunnels');
      return;
    }
    const chosen = await vscode.window.showQuickPick(
      tunnels.map((t) => ({ label: t.url, description: t.id, tunnelId: t.id })),
      { placeHolder: 'Select tunnel to stop' },
    );
    if (!chosen) return;
    await api(`/api/tunnels/${chosen.tunnelId}`, { method: 'DELETE' });
    vscode.window.showInformationMessage('Tunnel stopped');
    return;
  }

  try {
    await api(`/api/tunnels/${activeTunnel.id}`, { method: 'DELETE' });
    activeTunnel = null;
    statusBar?.hide();
    vscode.window.showInformationMessage('Tunnel stopped');
  } catch (e) {
    vscode.window.showErrorMessage(`Stop failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function listTunnels() {
  try {
    const tunnels = await api<Array<{ url: string; expiresAt: string; forwardPort: number; label?: string }>>(
      '/api/tunnels',
    );
    if (!tunnels.length) {
      vscode.window.showInformationMessage('No active tunnels');
      return;
    }
    const chosen = await vscode.window.showQuickPick(
      tunnels.map((t) => ({
        label: t.url,
        description: `${t.label ? t.label + ' · ' : ''}:${t.forwardPort} · expires ${new Date(t.expiresAt).toLocaleString()}`,
      })),
      { placeHolder: 'Active tunnels' },
    );
    if (chosen) {
      await vscode.env.clipboard.writeText(chosen.label);
      vscode.window.showInformationMessage('URL copied');
    }
  } catch (e) {
    vscode.window.showErrorMessage(`List failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function updateStatus(tunnel: TunnelResponse) {
  if (!statusBar) return;
  statusBar.text = `$(globe) ${tunnel.url}`;
  statusBar.tooltip = `Expires ${new Date(tunnel.expiresAt).toLocaleString()}`;
  statusBar.show();
}

async function api<T>(pathName: string, init?: RequestInit): Promise<T> {
  const cfg = vscode.workspace.getConfiguration('npmDockerSync');
  const base = (cfg.get<string>('url') || 'http://localhost:8080').replace(/\/$/, '');
  const token = cfg.get<string>('token') || '';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${base}${pathName}`, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
