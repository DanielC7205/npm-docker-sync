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

export class TunnelItem extends vscode.TreeItem {
  constructor(public readonly tunnel: TunnelListItem) {
    const title = tunnel.label?.trim() || tunnel.domain || tunnel.url;
    super(title, vscode.TreeItemCollapsibleState.None);
    this.id = tunnel.id;
    this.description = `:${tunnel.forwardPort}`;
    this.tooltip = `${tunnel.url}\n→ ${tunnel.forwardHost ?? '?'}:${tunnel.forwardPort}\nExpires ${new Date(tunnel.expiresAt).toLocaleString()}`;
    this.iconPath = new vscode.ThemeIcon('globe');
    this.contextValue = 'tunnel';
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
        .sort((a, b) => a.url.localeCompare(b.url))
        .map((t) => new TunnelItem(t));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return [new MessageItem(`Failed to load: ${msg}`, 'error')];
    }
  }
}
