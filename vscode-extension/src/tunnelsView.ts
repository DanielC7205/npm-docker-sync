import * as vscode from 'vscode';

export interface TunnelListItem {
  id: string;
  url: string;
  expiresAt: string;
  forwardPort: number;
  forwardHost?: string;
  label?: string | null;
  domain?: string;
}

export function formatExpiry(expiresAt: string, now = Date.now()): {
  short: string;
  full: string;
  msLeft: number;
  urgent: boolean;
  expired: boolean;
} {
  const end = new Date(expiresAt).getTime();
  const msLeft = end - now;
  const full = new Date(expiresAt).toLocaleString();

  if (!Number.isFinite(end)) {
    return { short: 'unknown', full: expiresAt, msLeft: 0, urgent: true, expired: true };
  }

  if (msLeft <= 0) {
    return { short: 'expired', full, msLeft, urgent: true, expired: true };
  }

  const minutes = Math.floor(msLeft / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  let short: string;
  if (days >= 1) short = `${days}d ${hours % 24}h left`;
  else if (hours >= 1) short = `${hours}h ${minutes % 60}m left`;
  else if (minutes >= 1) short = `${minutes}m left`;
  else short = `${Math.max(1, Math.ceil(msLeft / 1000))}s left`;

  return {
    short,
    full,
    msLeft,
    urgent: msLeft < 15 * 60_000,
    expired: false,
  };
}

export class TunnelItem extends vscode.TreeItem {
  constructor(public readonly tunnel: TunnelListItem) {
    const title = tunnel.label?.trim() || tunnel.domain || tunnel.url;
    super(title, vscode.TreeItemCollapsibleState.None);

    const expiry = formatExpiry(tunnel.expiresAt);
    this.id = tunnel.id;
    this.description = `:${tunnel.forwardPort} · ${expiry.short}`;
    this.tooltip = new vscode.MarkdownString(
      [
        `**${tunnel.url}**`,
        '',
        `Forward: \`${tunnel.forwardHost ?? '?'}:${tunnel.forwardPort}\``,
        `Expires: ${expiry.full} (${expiry.short})`,
        '',
        'Use **Extend** to add more time.',
      ].join('\n'),
    );
    this.iconPath = new vscode.ThemeIcon(
      expiry.expired ? 'error' : expiry.urgent ? 'warning' : 'globe',
      expiry.expired || expiry.urgent
        ? new vscode.ThemeColor(expiry.expired ? 'errorForeground' : 'editorWarning.foreground')
        : undefined,
    );
    this.contextValue = expiry.expired ? 'tunnelExpired' : 'tunnel';
    this.command = {
      command: 'npmDockerSync.openTunnelUrl',
      title: 'Open',
      arguments: [this],
    };
  }
}

export class MessageItem extends vscode.TreeItem {
  constructor(message: string, icon?: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon ?? 'info');
    this.contextValue = 'message';
  }
}

type TreeNode = TunnelItem | MessageItem;

export class TunnelsTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly fetchTunnels: () => Promise<TunnelListItem[]>) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (element) return [];

    try {
      const tunnels = await this.fetchTunnels();
      if (!tunnels.length) {
        return [new MessageItem('No active tunnels — click + to share a port', 'cloud-upload')];
      }
      return tunnels
        .slice()
        .sort((a, b) => new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime())
        .map((t) => new TunnelItem(t));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return [new MessageItem(`Failed to load: ${msg}`, 'error')];
    }
  }
}
