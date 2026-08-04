import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { TunnelItem, TunnelsTreeProvider, type TunnelListItem } from './tunnelsView';

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
let tunnelsProvider: TunnelsTreeProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'npmDockerSync.copyUrl';
  context.subscriptions.push(statusBar);

  tunnelsProvider = new TunnelsTreeProvider(async () => {
    const list = await api<TunnelListItem[]>('/api/tunnels');
    return list.map((t) => ({
      ...t,
      url: t.url || (t.domain ? `https://${t.domain}` : ''),
    }));
  });

  const treeView = vscode.window.createTreeView('npmDockerSync.tunnelsView', {
    treeDataProvider: tunnelsProvider,
    showCollapseAll: false,
  });
  context.subscriptions.push(treeView);

  // Refresh when the panel tab is focused
  context.subscriptions.push(
    treeView.onDidChangeVisibility((e) => {
      if (e.visible) tunnelsProvider?.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('npmDockerSync.sharePort', sharePort),
    vscode.commands.registerCommand('npmDockerSync.copyUrl', copyUrl),
    vscode.commands.registerCommand('npmDockerSync.stopTunnel', stopTunnel),
    vscode.commands.registerCommand('npmDockerSync.listTunnels', listTunnels),
    vscode.commands.registerCommand('npmDockerSync.refreshTunnels', () => tunnelsProvider?.refresh()),
    vscode.commands.registerCommand('npmDockerSync.copyTunnelUrl', async (item?: TunnelItem) => {
      const url = item?.tunnel.url;
      if (!url) return;
      await vscode.env.clipboard.writeText(url);
      vscode.window.showInformationMessage(`Copied ${url}`);
    }),
    vscode.commands.registerCommand('npmDockerSync.openTunnelUrl', async (item?: TunnelItem) => {
      const url = item?.tunnel.url;
      if (!url) return;
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand('npmDockerSync.stopTunnelItem', async (item?: TunnelItem) => {
      if (!item?.tunnel.id) return;
      try {
        await api(`/api/tunnels/${item.tunnel.id}`, { method: 'DELETE' });
        if (activeTunnel?.id === item.tunnel.id) {
          activeTunnel = null;
          statusBar?.hide();
        }
        tunnelsProvider?.refresh();
        vscode.window.showInformationMessage('Tunnel stopped');
      } catch (e) {
        vscode.window.showErrorMessage(`Stop failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
    vscode.commands.registerCommand('npmDockerSync.extendTunnel', async (item?: TunnelItem) => {
      if (!item?.tunnel.id) return;
      const picks: (vscode.QuickPickItem & { minutes: number })[] = [
        { label: '+30 minutes', description: 'Add to remaining time', minutes: 30 },
        { label: '+1 hour', description: 'Add to remaining time', minutes: 60 },
        { label: '+2 hours', description: 'Add to remaining time', minutes: 120 },
        { label: '+4 hours', description: 'Add to remaining time', minutes: 240 },
        { label: '+8 hours', description: 'Add to remaining time', minutes: 480 },
        { label: '+24 hours', description: 'Add to remaining time', minutes: 1440 },
        { label: 'Custom…', description: 'Add a custom number of minutes', minutes: -1 },
      ];
      const chosen = await vscode.window.showQuickPick(picks, {
        placeHolder: `Extend ${item.tunnel.label || item.tunnel.url}`,
      });
      if (!chosen) return;

      let ttl = chosen.minutes;
      if (ttl < 0) {
        const raw = await vscode.window.showInputBox({
          prompt: 'Extend by how many minutes?',
          value: '120',
          validateInput: (v) => {
            const n = Number(v);
            if (!Number.isFinite(n) || n < 5) return 'Enter at least 5 minutes';
            if (n > 60 * 24 * 7) return 'Max is 7 days (10080 minutes)';
            return undefined;
          },
        });
        if (!raw) return;
        ttl = Number(raw);
      }

      try {
        const updated = await api<{ id: string; url: string; expiresAt: string }>(
          `/api/tunnels/${item.tunnel.id}/extend`,
          { method: 'POST', body: JSON.stringify({ ttlMinutes: ttl }) },
        );
        if (activeTunnel?.id === item.tunnel.id) {
          activeTunnel = { ...activeTunnel, expiresAt: updated.expiresAt, url: updated.url };
          updateStatus(activeTunnel);
        }
        tunnelsProvider?.refresh();
        vscode.window.showInformationMessage(
          `Extended until ${new Date(updated.expiresAt).toLocaleString()}`,
        );
      } catch (e) {
        vscode.window.showErrorMessage(`Extend failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
  );

  // Keep expiry countdowns fresh while the panel is open
  const tick = setInterval(() => {
    if (treeView.visible) tunnelsProvider?.refresh();
  }, 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(tick) });
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

/** Prefer Tailscale (100.x), then private LAN IPv4 — what NPMplus should dial. */
function detectLocalIp(): string | undefined {
  const cfg = vscode.workspace.getConfiguration('npmDockerSync');
  const override = (cfg.get<string>('forwardHost') || '').trim();
  if (override) return override;

  const nets = os.networkInterfaces();
  const candidates: { ip: string; score: number }[] = [];

  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const entry of entries) {
      const family = entry.family as string | number;
      if (entry.internal || (family !== 'IPv4' && family !== 4)) continue;
      const ip = entry.address;
      let score = 10;
      if (ip.startsWith('100.')) score = 100; // Tailscale CGNAT
      else if (ip.startsWith('192.168.')) score = 80;
      else if (ip.startsWith('10.')) score = 70;
      else if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) score = 60;
      else score = 20;
      candidates.push({ ip, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.ip;
}

interface PortCandidate {
  port: number;
  protocol: 'TCP';
  /** True if something is actually listening now */
  listening: boolean;
  process?: string;
  pid?: number;
  bind?: string;
  /** Human hint e.g. Vite, Next.js */
  hint?: string;
  /** Set only when the process cwd is under an open workspace folder */
  workspace?: string;
}

const COMMON_PORT_HINTS: Record<number, string> = {
  3000: 'Next.js / Create React App',
  3001: 'Next.js (alt)',
  4000: 'Generic HTTP / GraphQL',
  4200: 'Angular',
  4321: 'Astro',
  5000: 'Flask / .NET / Vite preview',
  5173: 'Vite',
  5174: 'Vite (alt)',
  8000: 'Django / uvicorn',
  8080: 'Generic HTTP',
  8443: 'HTTPS alt',
  9229: 'Node debug',
};

function hintForPort(port: number, process?: string): string | undefined {
  if (COMMON_PORT_HINTS[port]) return COMMON_PORT_HINTS[port];
  const p = (process || '').toLowerCase();
  if (p.includes('node') || p.includes('npm') || p.includes('pnpm') || p.includes('yarn') || p.includes('bun')) {
    return 'Node.js';
  }
  if (p.includes('python') || p.includes('uvicorn') || p.includes('gunicorn')) return 'Python';
  if (p.includes('dotnet') || p.includes('aspnet')) return '.NET';
  if (p.includes('java') || p.includes('gradle')) return 'Java';
  if (p.includes('ruby') || p.includes('puma') || p.includes('rails')) return 'Ruby';
  if (p.includes('docker') || p.includes('com.docker') || p.includes('gvproxy') || p.includes('podman')) {
    return 'Container runtime';
  }
  if (p.includes('code') || p.includes('cursor')) return 'Editor';
  return undefined;
}

function workspaceFolders(): { name: string; root: string }[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => ({
    name: f.name || path.basename(f.uri.fsPath),
    root: path.resolve(f.uri.fsPath),
  }));
}

function workspaceForCwd(cwd: string | undefined, folders: { name: string; root: string }[]): string | undefined {
  if (!cwd || folders.length === 0) return undefined;
  const resolved = path.resolve(cwd);
  for (const f of folders) {
    if (resolved === f.root || resolved.startsWith(f.root + path.sep)) {
      return f.name;
    }
  }
  return undefined;
}

/** Map pid → cwd via lsof (macOS/Linux). */
async function resolveProcessCwds(pids: number[]): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  const unique = [...new Set(pids.filter((p) => p > 0))];
  if (unique.length === 0 || (process.platform !== 'darwin' && process.platform !== 'linux')) {
    return result;
  }

  try {
    // Batch cwd lookup: one lsof for many PIDs
    const { stdout } = await execFileAsync(
      'lsof',
      ['-a', '-d', 'cwd', '-Fn', `-p${unique.join(',')}`],
      { timeout: 4000, maxBuffer: 2 * 1024 * 1024 },
    );
    let pid: number | undefined;
    for (const raw of stdout.split('\n')) {
      if (!raw) continue;
      if (raw[0] === 'p') pid = Number(raw.slice(1)) || undefined;
      else if (raw[0] === 'n' && pid) {
        // n/path/to/cwd
        result.set(pid, raw.slice(1));
        pid = undefined;
      }
    }
  } catch {
    // optional enrichment
  }
  return result;
}

async function detectListeningPorts(): Promise<PortCandidate[]> {
  const byPort = new Map<number, PortCandidate>();
  const folders = workspaceFolders();

  try {
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const { stdout } = await execFileAsync(
        'lsof',
        ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'],
        { timeout: 4000, maxBuffer: 4 * 1024 * 1024 },
      );
      let pid: number | undefined;
      let command: string | undefined;

      for (const raw of stdout.split('\n')) {
        if (!raw) continue;
        const tag = raw[0];
        const val = raw.slice(1);
        if (tag === 'p') {
          pid = Number(val) || undefined;
          command = undefined;
        } else if (tag === 'c') {
          command = val;
        } else if (tag === 'n') {
          const m = val.match(/:(\d+)$/);
          if (!m) continue;
          const port = Number(m[1]);
          if (!(port > 0 && port < 65536)) continue;
          if (port < 1024) continue;

          const bind = val.replace(/:\d+$/, '') || '*';
          const existing = byPort.get(port);
          if (existing?.listening && bind.includes('127.') && !existing.bind?.includes('127.')) {
            continue;
          }
          byPort.set(port, {
            port,
            protocol: 'TCP',
            listening: true,
            process: command,
            pid,
            bind,
            hint: hintForPort(port, command),
          });
        }
      }
    } else if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('netstat', ['-ano'], {
        timeout: 4000,
        maxBuffer: 4 * 1024 * 1024,
      });
      for (const line of stdout.split('\n')) {
        if (!/LISTEN/i.test(line)) continue;
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        const local = parts[1];
        const pid = Number(parts[parts.length - 1]);
        const m = local.match(/:(\d+)$/);
        if (!m) continue;
        const port = Number(m[1]);
        if (!(port > 1024 && port < 65536)) continue;
        const bind = local.replace(/:\d+$/, '');
        byPort.set(port, {
          port,
          protocol: 'TCP',
          listening: true,
          pid: Number.isFinite(pid) ? pid : undefined,
          bind,
          hint: hintForPort(port),
        });
      }
    }
  } catch {
    // fall through to suggestions
  }

  const cwds = await resolveProcessCwds(
    [...byPort.values()].map((c) => c.pid).filter((p): p is number => typeof p === 'number'),
  );
  for (const c of byPort.values()) {
    if (!c.pid) continue;
    c.workspace = workspaceForCwd(cwds.get(c.pid), folders);
  }

  for (const port of Object.keys(COMMON_PORT_HINTS).map(Number)) {
    if (byPort.has(port)) continue;
    byPort.set(port, {
      port,
      protocol: 'TCP',
      listening: false,
      hint: COMMON_PORT_HINTS[port],
    });
  }

  return [...byPort.values()].sort((a, b) => {
    // Workspace-related listening first, then other listening, then suggestions
    const rank = (c: PortCandidate) => {
      if (c.listening && c.workspace) return 0;
      if (c.listening) return 1;
      return 2;
    };
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    return a.port - b.port;
  });
}

function portPickLabel(c: PortCandidate): string {
  return `$(radio-tower) ${c.port}`;
}

function portPickDescription(c: PortCandidate): string {
  const bits: string[] = [c.protocol];
  if (c.listening) {
    bits.push('listening');
    if (c.process) bits.push(c.process);
  } else {
    bits.push('suggested');
  }
  if (c.hint) bits.push(c.hint);
  if (c.workspace) bits.push(`↗ ${c.workspace}`);
  return bits.join(' · ');
}

function portPickDetail(c: PortCandidate): string {
  if (c.listening) {
    const where = c.bind ? `bound ${c.bind}:${c.port}` : `port ${c.port}`;
    const proc = c.process ? `${c.process}${c.pid ? ` (pid ${c.pid})` : ''}` : 'unknown process';
    if (c.workspace) {
      return `${where} · ${proc} · from workspace ${c.workspace}`;
    }
    return `${where} · ${proc} · system / other app`;
  }
  return `Not listening yet · common ${c.hint ?? 'dev'} port`;
}

async function sharePort() {
  const candidates = await detectListeningPorts();
  const project = workspaceLabel();
  const host = detectLocalIp();

  if (!host) {
    vscode.window.showErrorMessage(
      'Could not detect a local IPv4 address. Set npmDockerSync.forwardHost to an IP NPMplus can reach.',
    );
    return;
  }

  const related = candidates.filter((c) => c.listening && c.workspace);
  const otherListening = candidates.filter((c) => c.listening && !c.workspace);
  const suggested = candidates.filter((c) => !c.listening);

  type PortPick = vscode.QuickPickItem & { portValue: string };

  const picks: PortPick[] = [
    ...related.slice(0, 20).map((c) => ({
      label: portPickLabel(c),
      description: portPickDescription(c),
      detail: portPickDetail(c),
      portValue: String(c.port),
    })),
    ...otherListening.slice(0, 25).map((c) => ({
      label: portPickLabel(c),
      description: portPickDescription(c),
      detail: portPickDetail(c),
      portValue: String(c.port),
    })),
    ...suggested.slice(0, 12).map((c) => ({
      label: portPickLabel(c),
      description: portPickDescription(c),
      detail: portPickDetail(c),
      portValue: String(c.port),
    })),
    {
      label: '$(edit) Enter a custom port…',
      description: 'Type any TCP port',
      detail: `Will tunnel via ${host}; default name “${project}”`,
      portValue: '__custom__',
    },
  ];

  const chosen = await vscode.window.showQuickPick(picks, {
    placeHolder: `Share a port for “${project}” → ${host}`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!chosen) return;

  let portStr: string | undefined;
  if (chosen.portValue === '__custom__') {
    portStr = await vscode.window.showInputBox({
      prompt: 'Local port to share',
      value: related[0]?.port?.toString() ?? otherListening[0]?.port?.toString() ?? '3000',
      validateInput: (v) =>
        /^\d+$/.test(v) && Number(v) > 0 && Number(v) < 65536 ? undefined : 'Enter a valid port',
    });
  } else {
    portStr = chosen.portValue;
  }
  if (!portStr) return;

  const label = await vscode.window.showInputBox({
    prompt: 'Tunnel name (used in the hostname)',
    value: project,
    placeHolder: project,
  });
  if (label === undefined) return;

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
    tunnelsProvider?.refresh();
    const pick = await vscode.window.showInformationMessage(
      `Tunnel ready: ${tunnel.url} → ${host}:${portStr} (copied)`,
      'Copy again',
      'Open',
      'Stop',
    );
    if (pick === 'Copy again') {
      await vscode.env.clipboard.writeText(tunnel.url);
    } else if (pick === 'Open') {
      await vscode.env.openExternal(vscode.Uri.parse(tunnel.url));
    } else if (pick === 'Stop') {
      await stopTunnel();
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(
      `Tunnel failed: ${msg}` +
        (msg.includes('certificate') || msg.includes('TLS') || msg.includes('SSL')
          ? ' Set Settings → TLS → Tunnel certificate to a wildcard covering TUNNEL_BASE_DOMAIN.'
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
    tunnelsProvider?.refresh();
    vscode.window.showInformationMessage('Tunnel stopped');
    return;
  }

  try {
    await api(`/api/tunnels/${activeTunnel.id}`, { method: 'DELETE' });
    activeTunnel = null;
    statusBar?.hide();
    tunnelsProvider?.refresh();
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
  const end = new Date(tunnel.expiresAt);
  const mins = Math.max(0, Math.round((end.getTime() - Date.now()) / 60_000));
  statusBar.text = `$(globe) ${tunnel.url}`;
  statusBar.tooltip = `Expires ${end.toLocaleString()} (${mins}m left)`;
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
