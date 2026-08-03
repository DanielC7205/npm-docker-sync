import * as vscode from 'vscode';

interface TunnelResponse {
  id: string;
  url: string;
  expiresAt: string;
  domain?: string;
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

async function sharePort() {
  const portStr = await vscode.window.showInputBox({
    prompt: 'Local port to share',
    value: '3000',
    validateInput: (v) => (/^\d+$/.test(v) && Number(v) > 0 && Number(v) < 65536 ? undefined : 'Enter a valid port'),
  });
  if (!portStr) return;

  const label = await vscode.window.showInputBox({
    prompt: 'Optional label',
    placeHolder: 'my-dev-server',
  });

  const cfg = vscode.workspace.getConfiguration('npmDockerSync');
  const host = (cfg.get<string>('forwardHost') || '').trim() || undefined;

  try {
    const tunnel = await api<TunnelResponse>('/api/tunnels', {
      method: 'POST',
      body: JSON.stringify({
        port: Number(portStr),
        label: label || undefined,
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
    vscode.window.showErrorMessage(`Tunnel failed: ${e instanceof Error ? e.message : String(e)}`);
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
      tunnels.map((t) => ({ label: t.url, id: t.id })),
      { placeHolder: 'Select tunnel to stop' },
    );
    if (!chosen) return;
    await api(`/api/tunnels/${chosen.id}`, { method: 'DELETE' });
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
    const tunnels = await api<Array<{ url: string; expiresAt: string; forwardPort: number }>>('/api/tunnels');
    if (!tunnels.length) {
      vscode.window.showInformationMessage('No active tunnels');
      return;
    }
    const chosen = await vscode.window.showQuickPick(
      tunnels.map((t) => ({
        label: t.url,
        description: `:${t.forwardPort} · expires ${new Date(t.expiresAt).toLocaleString()}`,
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

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const cfg = vscode.workspace.getConfiguration('npmDockerSync');
  const base = (cfg.get<string>('url') || 'http://localhost:8080').replace(/\/$/, '');
  const token = cfg.get<string>('token') || '';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${base}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
