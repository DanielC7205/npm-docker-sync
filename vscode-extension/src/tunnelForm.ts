import * as vscode from 'vscode';

export interface PortCandidate {
  port: number;
  protocol: 'TCP';
  listening: boolean;
  process?: string;
  pid?: number;
  bind?: string;
  hint?: string;
  workspace?: string;
}

export interface TunnelResponse {
  id: string;
  url: string;
  expiresAt: string;
  domain?: string;
  slug?: string;
  forwardHost?: string;
  forwardPort?: number;
  forwardScheme?: string;
  label?: string | null;
  disableOnExpire?: boolean | null;
  locations?: Array<{
    mode?: string;
    path: string;
    forwardScheme?: string | null;
    forwardHost?: string | null;
    forwardPort?: number | null;
    forwardPath?: string | null;
  }> | null;
}

export function portPickDetail(c: PortCandidate): string {
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

type ApiFn = <T>(pathName: string, init?: RequestInit) => Promise<T>;

export async function openTunnelFormModal(
  api: ApiFn,
  opts: {
    mode: 'create' | 'edit';
    candidates: PortCandidate[];
    project: string;
    forwardHost: string;
    defaultScheme: string;
    defaultTtlMinutes: number;
    defaultDisableOnExpire: boolean;
    existing?: TunnelResponse;
  },
): Promise<TunnelResponse | null> {
  const ports = uniqueNumbers(opts.candidates.map((c) => c.port)).slice(0, 60);
  const suggestedPort = opts.existing?.forwardPort
    ?? ports.find((p) => p > 0)
    ?? 3000;
  const portDetailsByPort: Record<number, string> = {};
  for (const c of opts.candidates) {
    if (portDetailsByPort[c.port] == null) portDetailsByPort[c.port] = portPickDetail(c);
  }

  const initialLocations = opts.existing?.locations ?? [];
  const nonce = Math.random().toString(36).slice(2);
  const isEdit = opts.mode === 'edit';

  const panel = vscode.window.createWebviewPanel(
    'npmDockerSyncTunnelForm',
    isEdit ? 'Edit NPM Tunnel' : 'Create NPM Tunnel',
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: false },
  );

  const cspSource = panel.webview.cspSource;
  const portOptionsHtml = ports
    .map((p) => {
      const detail = escapeHtml(portDetailsByPort[p] ?? '');
      const sel = p === suggestedPort ? 'selected' : '';
      return `<option value="${p}" ${sel}>${p} — ${detail}</option>`;
    })
    .join('');

  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <style>
      :root {
        color-scheme: light dark;
      }
      body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 16px;
        margin: 0;
      }
      h2 { margin: 0 0 8px; font-size: 1.25rem; font-weight: 600; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      .full { grid-column: 1 / -1; }
      label { font-size: 12px; color: var(--vscode-descriptionForeground); display: block; margin-bottom: 6px; }
      input[type="text"], input[type="number"], select, textarea {
        width: 100%; box-sizing: border-box;
        padding: 8px 10px; border-radius: 4px;
        border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
      }
      .row { display:flex; gap: 12px; align-items:center; justify-content:space-between; }
      .persist {
        padding: 8px 10px; border-radius: 4px;
        border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
        background: var(--vscode-input-background);
      }
      .actions { display:flex; gap: 10px; justify-content:flex-end; margin-top: 16px; }
      button {
        padding: 8px 14px; border-radius: 4px; cursor: pointer;
        border: 1px solid var(--vscode-button-border, transparent);
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
      }
      button.primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }
      button:disabled { opacity: 0.55; cursor: default; }
      .note { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 6px; line-height: 1.35; }
      .error { margin-top: 12px; color: var(--vscode-errorForeground); font-size: 13px; white-space: pre-wrap; }
      .loc { border: 1px solid var(--vscode-widget-border); border-radius: 4px; padding: 10px; margin-top: 8px; }
      .loc-grid { display:grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
    </style>
  </head>
  <body>
    <h2>${isEdit ? 'Edit tunnel' : 'Create tunnel'}</h2>
    <div class="note">TLS is configured on the server. This form sets the upstream target, TTL, persistence, and optional path locations.</div>
    <div class="grid" style="margin-top: 14px">
      <div>
        <label>Local port</label>
        <select id="portSelect">
          <option value="">Type a custom port…</option>
          ${portOptionsHtml}
        </select>
        <input id="port" type="number" min="1" max="65535" value="${suggestedPort}" style="margin-top:6px" />
        <div class="note" id="portDetail"></div>
      </div>
      <div>
        <label>Upstream scheme</label>
        <select id="scheme">
          <option value="http" ${(opts.existing?.forwardScheme || opts.defaultScheme) === 'http' ? 'selected' : ''}>http</option>
          <option value="https" ${(opts.existing?.forwardScheme || opts.defaultScheme) === 'https' ? 'selected' : ''}>https</option>
        </select>
      </div>

      ${isEdit ? '' : `<div>
        <label>TTL minutes</label>
        <input id="ttlMinutes" type="number" min="5" max="10080" value="${opts.defaultTtlMinutes}" />
      </div>`}
      <div class="${isEdit ? 'full' : ''}">
        <label>Persist after expiry</label>
        <div class="row persist">
          <span id="persistLabel" style="font-size: 13px">${(opts.existing?.disableOnExpire ?? opts.defaultDisableOnExpire) ? 'Keep (fallback / disable on expiry)' : 'Auto delete on expiry'}</span>
          <input id="disableOnExpire" type="checkbox" ${(opts.existing?.disableOnExpire ?? opts.defaultDisableOnExpire) ? 'checked' : ''} />
        </div>
      </div>

      <div class="full">
        <label>Tunnel name</label>
        <input id="label" type="text" value="${escapeHtml(opts.existing?.label || opts.project)}" ${isEdit ? '' : ''} />
      </div>
      <div class="full">
        <label>Forward host</label>
        <input id="host" type="text" value="${escapeHtml(opts.existing?.forwardHost || opts.forwardHost)}" />
      </div>

      ${isEdit ? '' : `<div class="full">
        <label class="row"><span>Remember defaults</span><input id="remember" type="checkbox" /></label>
      </div>`}

      <div class="full">
        <label>Custom locations (manual)</label>
        <div id="locations"></div>
        <button type="button" id="addLoc" style="margin-top:8px">Add location</button>
      </div>
    </div>

    <div id="error" class="error" style="display:none"></div>
    <div class="actions">
      <button id="cancel">Cancel</button>
      <button class="primary" id="submit">${isEdit ? 'Save' : 'Create & Copy URL'}</button>
    </div>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const $ = (id) => document.getElementById(id);
      const isEdit = ${isEdit ? 'true' : 'false'};
      const portDetailsByPort = ${JSON.stringify(portDetailsByPort)};
      let locations = ${JSON.stringify(initialLocations.map((l) => ({
        path: l.path || '/',
        forwardScheme: l.forwardScheme || 'http',
        forwardHost: l.forwardHost || '',
        forwardPort: l.forwardPort ?? '',
        forwardPath: l.forwardPath || '',
      })))};

      function setError(msg) {
        const el = $('error');
        if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
        el.style.display = 'block';
        el.textContent = msg;
      }

      function updatePersistLabel() {
        $('persistLabel').textContent = $('disableOnExpire').checked
          ? 'Keep (fallback / disable on expiry)'
          : 'Auto delete on expiry';
      }

      function updatePortDetail() {
        const port = Number($('port').value);
        $('portDetail').textContent = portDetailsByPort[port] ?? '';
      }

      function renderLocations() {
        const root = $('locations');
        root.innerHTML = '';
        locations.forEach((loc, i) => {
          const div = document.createElement('div');
          div.className = 'loc';
          div.innerHTML = \`
            <div class="loc-grid">
              <div><label>Path</label><input data-i="\${i}" data-k="path" value="\${loc.path || '/'}" /></div>
              <div><label>Scheme</label>
                <select data-i="\${i}" data-k="forwardScheme">
                  <option value="http" \${loc.forwardScheme === 'https' ? '' : 'selected'}>http</option>
                  <option value="https" \${loc.forwardScheme === 'https' ? 'selected' : ''}>https</option>
                </select>
              </div>
              <div><label>Port</label><input data-i="\${i}" data-k="forwardPort" type="number" value="\${loc.forwardPort ?? ''}" /></div>
              <div style="grid-column:1/-1"><label>Host</label><input data-i="\${i}" data-k="forwardHost" value="\${loc.forwardHost || ''}" /></div>
              <div style="grid-column:1/-1"><label>Forward path</label><input data-i="\${i}" data-k="forwardPath" value="\${loc.forwardPath || ''}" /></div>
            </div>
            <button type="button" data-remove="\${i}" style="margin-top:8px">Remove</button>
          \`;
          root.appendChild(div);
        });
        root.querySelectorAll('[data-k]').forEach((el) => {
          el.addEventListener('input', () => {
            const i = Number(el.getAttribute('data-i'));
            const k = el.getAttribute('data-k');
            locations[i][k] = el.value;
          });
          el.addEventListener('change', () => {
            const i = Number(el.getAttribute('data-i'));
            const k = el.getAttribute('data-k');
            locations[i][k] = el.value;
          });
        });
        root.querySelectorAll('[data-remove]').forEach((btn) => {
          btn.addEventListener('click', () => {
            locations.splice(Number(btn.getAttribute('data-remove')), 1);
            renderLocations();
          });
        });
      }

      $('portSelect').addEventListener('change', () => {
        if ($('portSelect').value) {
          $('port').value = $('portSelect').value;
          updatePortDetail();
        }
      });
      $('port').addEventListener('input', updatePortDetail);
      $('disableOnExpire').addEventListener('change', updatePersistLabel);
      $('addLoc').addEventListener('click', () => {
        locations.push({ path: '/', forwardScheme: 'http', forwardHost: '', forwardPort: '', forwardPath: '' });
        renderLocations();
      });
      $('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg && msg.type === 'error') {
          setError(msg.message);
          $('submit').disabled = false;
        }
      });

      $('submit').addEventListener('click', () => {
        setError('');
        const port = Number($('port').value);
        const scheme = $('scheme').value;
        const disableOnExpire = $('disableOnExpire').checked;
        const label = ($('label').value || '').trim();
        const host = ($('host').value || '').trim();
        const remember = !isEdit && $('remember') && $('remember').checked;
        const ttlEl = $('ttlMinutes');
        const ttlMinutes = ttlEl ? Number(ttlEl.value) : undefined;

        if (!Number.isFinite(port) || port < 1 || port > 65535) return setError('Enter a valid port (1-65535).');
        if (!isEdit && (!Number.isFinite(ttlMinutes) || ttlMinutes < 5 || ttlMinutes > 10080)) return setError('Enter TTL minutes (5-10080).');
        if (!host) return setError('Forward host is required.');

        const locs = locations
          .filter((l) => (l.path || '').trim())
          .map((l) => ({
            mode: 'manual',
            path: l.path || '/',
            forwardScheme: l.forwardScheme || 'http',
            forwardHost: l.forwardHost || '',
            forwardPort: l.forwardPort === '' || l.forwardPort == null ? null : Number(l.forwardPort),
            forwardPath: l.forwardPath || null,
          }));

        $('submit').disabled = true;
        vscode.postMessage({
          type: 'submit',
          payload: {
            port, scheme, disableOnExpire, label: label || null, host,
            ttlMinutes, remember, locations: locs,
          },
        });
      });

      updatePortDetail();
      updatePersistLabel();
      renderLocations();
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

    panel.onDidDispose(() => disposeAndResolve(null));

    panel.webview.onDidReceiveMessage(async (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'cancel') {
        disposeAndResolve(null);
        return;
      }
      if (message.type !== 'submit') return;

      const payload = message.payload as {
        port: number;
        ttlMinutes?: number;
        scheme: string;
        disableOnExpire: boolean;
        label: string | null;
        host: string;
        remember?: boolean;
        locations: Array<{
          mode: string;
          path: string;
          forwardScheme: string;
          forwardHost: string;
          forwardPort: number | null;
          forwardPath: string | null;
        }>;
      };

      try {
        if (payload.remember) {
          const cfg = vscode.workspace.getConfiguration('npmDockerSync');
          await cfg.update('tunnelScheme', payload.scheme, vscode.ConfigurationTarget.Global);
          if (payload.ttlMinutes != null) {
            await cfg.update('tunnelTtlMinutes', payload.ttlMinutes, vscode.ConfigurationTarget.Global);
          }
          await cfg.update('tunnelDisableOnExpire', payload.disableOnExpire, vscode.ConfigurationTarget.Global);
        }

        if (isEdit && opts.existing?.id) {
          const updated = await api<TunnelResponse>(`/api/tunnels/${opts.existing.id}`, {
            method: 'PATCH',
            body: JSON.stringify({
              port: payload.port,
              scheme: payload.scheme,
              host: payload.host,
              label: payload.label ?? undefined,
              disableOnExpire: payload.disableOnExpire,
              locations: payload.locations,
            }),
          });
          disposeAndResolve(updated);
          return;
        }

        const created = await api<TunnelResponse>('/api/tunnels', {
          method: 'POST',
          body: JSON.stringify({
            port: payload.port,
            scheme: payload.scheme,
            ttlMinutes: payload.ttlMinutes,
            label: payload.label ?? undefined,
            host: payload.host,
            disableOnExpire: payload.disableOnExpire,
            locations: payload.locations,
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
