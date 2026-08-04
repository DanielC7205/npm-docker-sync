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

function uniqueNumbers(nums: number[]) {
  return [...new Set(nums)].sort((a, b) => a - b);
}

async function openTunnelCreateModal(opts: {
  candidates: PortCandidate[];
  project: string;
  forwardHost: string;
  defaultScheme: string;
  defaultTtlMinutes: number;
  defaultDisableOnExpire: boolean;
}): Promise<TunnelResponse | null> {
  const ports = uniqueNumbers(opts.candidates.map((c) => c.port)).slice(0, 60);
  const suggestedPort = ports.find((p) => p > 0) ?? 3000;
  const portDetailsByPort: Record<number, string> = {};
  for (const c of opts.candidates) {
    if (portDetailsByPort[c.port] == null) portDetailsByPort[c.port] = portPickDetail(c);
  }
  const nonce = Math.random().toString(36).slice(2);

  const panel = vscode.window.createWebviewPanel(
    'npmDockerSyncCreateTunnel',
    'Create NPM Tunnel',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: false },
  );

  const cspSource = panel.webview.cspSource;

  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif; padding: 16px; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      .full { grid-column: 1 / -1; }
      label { font-size: 12px; color: #666; display: block; margin-bottom: 6px; }
      input[type="text"], input[type="number"], select { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid #ddd; background: #fff; }
      .row { display:flex; gap: 12px; align-items:center; justify-content:space-between; }
      .actions { display:flex; gap: 10px; justify-content:flex-end; margin-top: 16px; }
      button { padding: 8px 12px; border-radius: 8px; border: 1px solid #ddd; background: #f6f6f6; cursor: pointer; }
      button.primary { background: #2f6fed; border-color: #2f6fed; color: #fff; }
      .note { font-size: 12px; color: #666; margin-top: 8px; line-height: 1.35; }
      .error { margin-top: 12px; color: #b00020; font-size: 13px; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <h2 style="margin-top:0">Tunnel creation</h2>
    <div class="note">
      TLS for tunnels is handled by the server settings (wildcard cert / domain map). This form controls the tunnel target + expiry/persistence.
    </div>
    <div class="grid" style="margin-top: 14px">
      <div>
        <label>Local port</label>
        <input id="port" type="number" list="ports" min="1" max="65535" value="${suggestedPort}" />
        <datalist id="ports">
          ${ports.map((p) => `<option value="${p}"></option>`).join('')}
        </datalist>
        <div class="note" id="portDetail"></div>
      </div>
      <div>
        <label>Upstream scheme</label>
        <select id="scheme">
          <option value="http" ${opts.defaultScheme === 'http' ? 'selected' : ''}>http</option>
          <option value="https" ${opts.defaultScheme === 'https' ? 'selected' : ''}>https</option>
        </select>
      </div>

      <div>
        <label>TTL minutes</label>
        <input id="ttlMinutes" type="number" min="5" max="10080" value="${opts.defaultTtlMinutes}" />
      </div>
      <div>
        <label>Persist after expiry</label>
        <div class="row" style="padding: 8px 10px; border-radius: 8px; border: 1px solid #ddd;">
          <span style="font-size: 13px; color:#333">${opts.defaultDisableOnExpire ? 'Keep (disable on expiry)' : 'Auto delete on expiry'}</span>
          <input id="disableOnExpire" type="checkbox" ${opts.defaultDisableOnExpire ? 'checked' : ''} />
        </div>
        <div class="note">Keep mode disables the NPMplus proxy host on expiry (does not delete).</div>
      </div>

      <div class="full">
        <label>Tunnel name (used in hostname)</label>
        <input id="label" type="text" value="${escapeHtml(opts.project)}" />
      </div>
      <div class="full">
        <label>Forward host (NPMplus dials this)</label>
        <input id="host" type="text" value="${escapeHtml(opts.forwardHost)}" />
        <div class="note">Leave as-is unless NPMplus can’t reach your machine.</div>
      </div>
    </div>

    <div id="error" class="error" style="display:none"></div>

    <div class="actions">
      <button id="cancel">Cancel</button>
      <button class="primary" id="create">Create & Copy URL</button>
    </div>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const $ = (id) => document.getElementById(id);
      const portDetailsByPort = ${JSON.stringify(portDetailsByPort)};

      function setError(msg) {
        const el = $('error');
        if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
        el.style.display = 'block';
        el.textContent = msg;
      }

      function updatePortDetail() {
        const port = Number($('port').value);
        const detail = portDetailsByPort[port] ?? '';
        const el = $('portDetail');
        if (!el) return;
        el.textContent = detail;
      }

      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg && msg.type === 'error') setError(msg.message);
      });

      $('cancel').addEventListener('click', () => {
        vscode.postMessage({ type: 'cancel' });
      });

      $('port').addEventListener('input', updatePortDetail);
      updatePortDetail();

      $('create').addEventListener('click', async () => {
        setError('');
        const port = Number($('port').value);
        const ttlMinutes = Number($('ttlMinutes').value);
        const scheme = $('scheme').value;
        const disableOnExpire = $('disableOnExpire').checked;
        const label = $('label').value || '';
        const host = $('host').value || '';

        if (!Number.isFinite(port) || port < 1 || port > 65535) return setError('Enter a valid port (1-65535).');
        if (!Number.isFinite(ttlMinutes) || ttlMinutes < 5 || ttlMinutes > 10080) return setError('Enter TTL minutes (5-10080).');
        if (!host) return setError('Forward host is required (the machine NPMplus dials).');

        vscode.postMessage({
          type: 'create',
          payload: { port, ttlMinutes, scheme, disableOnExpire, label: label.trim() || null, host: host.trim() },
        });
      });
    </script>
  </body>
</html>`;

  panel.webview.html = html;

  return await new Promise<TunnelResponse | null>((resolve) => {
    let settled = false;
    const disposeAndResolve = (val: TunnelResponse | null) => {
      if (settled) return;
      settled = true;
      try { panel.dispose(); } catch { /* ignore */ }
      resolve(val);
    };

    panel.onDidDispose(() => {
      disposeAndResolve(null);
    });

    panel.webview.onDidReceiveMessage(async (message) => {
      if (!message || typeof message !== 'object') return;

      if (message.type === 'cancel') {
        disposeAndResolve(null);
        return;
      }

      if (message.type !== 'create') return;

      const payload = message.payload as {
        port: number;
        ttlMinutes: number;
        scheme: string;
        disableOnExpire: boolean;
        label: string | null;
        host: string;
      };

      try {
        const created = await api<TunnelResponse>('/api/tunnels', {
          method: 'POST',
          body: JSON.stringify({
            port: payload.port,
            scheme: payload.scheme,
            ttlMinutes: payload.ttlMinutes,
            label: payload.label ?? undefined,
            host: payload.host,
            disableOnExpire: payload.disableOnExpire,
          }),
        });
        disposeAndResolve(created);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        panel.webview.postMessage({ type: 'error', message: msg });
      }
    });
  });
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case '\'': return '&#39;';
      default: return ch;
    }
  });
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

  const modalCfg = vscode.workspace.getConfiguration('npmDockerSync');
  const modalDefaultScheme = (modalCfg.get<string>('tunnelScheme') || 'http').trim();
  const modalDefaultTtl = Number(modalCfg.get<number>('tunnelTtlMinutes') ?? 120);
  const modalDefaultDisableOnExpire = !!modalCfg.get<boolean>('tunnelDisableOnExpire');

  const tunnel = await openTunnelCreateModal({
    candidates,
    project,
    forwardHost: host,
    defaultScheme: modalDefaultScheme,
    defaultTtlMinutes: Number.isFinite(modalDefaultTtl) ? modalDefaultTtl : 120,
    defaultDisableOnExpire: modalDefaultDisableOnExpire,
  });

  if (!tunnel) return;

  activeTunnel = tunnel;
  try {
    await vscode.env.clipboard.writeText(tunnel.url);
  } catch {
    // Clipboard failures should not block tunnel creation.
  }
  updateStatus(tunnel);
  tunnelsProvider?.refresh();

  const pick = await vscode.window.showInformationMessage(
    `Tunnel ready: ${tunnel.url} (copied)`,
    'Open',
    'Stop',
  );
  if (pick === 'Open') {
    await vscode.env.openExternal(vscode.Uri.parse(tunnel.url));
  } else if (pick === 'Stop') {
    await stopTunnel();
  }
  return;

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
  if (chosen!.portValue === '__custom__') {
    portStr = await vscode.window.showInputBox({
      prompt: 'Local port to share',
      value: related[0]?.port?.toString() ?? otherListening[0]?.port?.toString() ?? '3000',
      validateInput: (v) =>
        /^\d+$/.test(v) && Number(v) > 0 && Number(v) < 65536 ? undefined : 'Enter a valid port',
    });
  } else {
    portStr = chosen!.portValue;
  }
  if (!portStr) return;

  const cfg = vscode.workspace.getConfiguration('npmDockerSync');
  const defaultScheme = (cfg.get<string>('tunnelScheme') || 'http').trim();
  const defaultTtl = Number(cfg.get<number>('tunnelTtlMinutes') ?? 120);
  const defaultDisableOnExpire = !!cfg.get<boolean>('tunnelDisableOnExpire');

  const schemeChoice = await vscode.window.showQuickPick(
    [
      { label: 'http', value: 'http' },
      { label: 'https', value: 'https' },
    ],
    { placeHolder: `Upstream scheme (default: ${defaultScheme})` },
  );
  if (!schemeChoice) return;

  const ttlOptions: (vscode.QuickPickItem & { minutes: number; isCustom?: boolean })[] = [
    { label: '15 minutes', minutes: 15 },
    { label: '30 minutes', minutes: 30 },
    { label: '60 minutes', minutes: 60 },
    { label: '2 hours', minutes: 120 },
    { label: '4 hours', minutes: 240 },
    { label: '8 hours', minutes: 480 },
    { label: '24 hours', minutes: 1440 },
    { label: 'Custom…', minutes: 0, isCustom: true },
  ];

  const ttlPick = await vscode.window.showQuickPick(ttlOptions, {
    placeHolder: `TTL (default: ${defaultTtl} minutes)`,
  });
  if (!ttlPick) return;

  let ttlMinutes = defaultTtl;
  if (ttlPick!.isCustom) {
    const raw = await vscode.window.showInputBox({
      prompt: 'TTL minutes',
      value: String(defaultTtl),
      validateInput: (v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 5 || n > 10080) return 'Enter 5-10080';
        return undefined;
      },
    });
    if (!raw) return;
    ttlMinutes = Number(raw);
  } else {
    ttlMinutes = ttlPick!.minutes;
  }

  const persistPick = await vscode.window.showQuickPick(
    [
      { label: defaultDisableOnExpire ? 'Persist (disable on expiry)' : 'Persist (disable on expiry)', disable: true },
      { label: defaultDisableOnExpire ? 'Auto delete on expiry' : 'Auto delete on expiry', disable: false },
    ],
    { placeHolder: 'On expiry: disable (persist) or delete?' },
  );
  if (!persistPick) return;
  const disableOnExpire = persistPick!.disable;

  const rememberPick = await vscode.window.showQuickPick(['Use once', 'Remember for next time'], {
    placeHolder: 'Remember these tunnel defaults?',
  });
  if (!rememberPick) return;

  if (rememberPick === 'Remember for next time') {
    await cfg.update('tunnelScheme', schemeChoice!.value, vscode.ConfigurationTarget.Global);
    await cfg.update('tunnelTtlMinutes', ttlMinutes, vscode.ConfigurationTarget.Global);
    await cfg.update('tunnelDisableOnExpire', disableOnExpire, vscode.ConfigurationTarget.Global);
  }

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
        scheme: schemeChoice!.value,
        ttlMinutes,
        label: (label || project).trim() || undefined,
        host,
        disableOnExpire,
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
  } catch (e: any) {
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
