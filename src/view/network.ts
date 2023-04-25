import * as vscode from "vscode";
import { getWebviewContent } from "./webview";
import { MessageEvent, ViteNetwork, ViteNode, ViteNodeStatus } from "../types/types";
import { Ctx } from "../ctx";

export class NetworkViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "ViteNetworkView";
  private _webviewView?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];
  private _onDidDispose = new vscode.EventEmitter<void>();
  readonly onDidDispose: vscode.Event<void> = this._onDidDispose.event;
  private _onDidChangeNode = new vscode.EventEmitter<ViteNode>();
  readonly onDidChangeNode: vscode.Event<ViteNode> = this._onDidChangeNode.event;
  private localNodePid: any;
  private requestingSet: Set<string> = new Set();

  constructor(private readonly ctx: Ctx) {
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._webviewView = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    let timer: any;
    webviewView.onDidDispose(() => {
      if (timer) {
        clearInterval(timer);
      }
      this._onDidDispose.fire();
      this.dispose();
    }, null, this.disposables);

    webviewView.webview.onDidReceiveMessage(async(event: MessageEvent) => {
      if (event.command !== "log") {
        this.ctx.log.debug(`[receivedMessage=${this.constructor.name}]`, event);
      }
      switch (event.command) {
        case "log":
          const method = event.subCommand as "info" | "debug" | "warn" | "error" | "log";
          const msg: [unknown, ...unknown[]] = event.message;
          this.ctx.log[method](...msg, `[${this.constructor.name}]`);
          break;
        case "mounted":
          {
            await this.postMessage({
              command: "setViteNode",
              message: {
                viteNodesList: this.ctx.getViteNodesList(),
              }
            });
            await this.updateSnapshotChainHeight();
            timer = setInterval(async() => {
              await this.updateSnapshotChainHeight();
            }, 1000 * 10);
          }
          break;
        case "startLocalViteNode":
          await this.startLocalViteNode();
          setTimeout(async() => {
            await this.updateSnapshotChainHeight();
          }, 3000);
          break;
        case "stopLocalViteNode":
          await this.stopLocalViteNode();
          break;
        case "reconnect":
          {
            const { name } = event.message;
            const node = this.ctx.getViteNode(name);
            delete node?.error;
            node!.status = ViteNodeStatus.Syncing;
            this.ctx.resetProvider(name);
            setTimeout(async () => {
              await this.updateSnapshotChainHeight();
            }, 3000);
          }
          break;
        case "saveCustomNode":
          {
            const { node, target } = event.message;
            const isGlobal = target === "Global";
            this.ctx.config.addViteCusomNode(node, isGlobal);
          }
          break;
        case "deleteCustomNode":
          {
            const { node } = event.message;
            this.ctx.config.deleteViteCusomNode(node);
         }
          break;
      }
    }, null, this.disposables);

    webviewView.webview.html = getWebviewContent(webviewView.webview, this.ctx.extensionUri, "network");
  }

  public async postMessage(message: any): Promise<boolean> {
    if (message.command !== "updateSnapshotChainHeight") {
      this.ctx.log.debug(`[postMessage=${this.constructor.name}]`, message);
    }
    if (this._webviewView) {
      return this._webviewView.webview.postMessage(message);
    } else {
      this.ctx.log.debug(this.constructor.name, "webviewView is null");
      return false;
    }
  }

  public dispose() {
    this.localNodePid?.stop();
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  public async startLocalViteNode() {
    const node = this.ctx.getViteNode("local");
    delete node!.error;
    await this.postMessage({
      command: "updateViteNode",
      message: {
        ...node,
        status: ViteNodeStatus.Syncing
      },
    });
    const nodeConfig = {
      "nodes": {
        "local": {
          "name": "gvite",
          "version": node!.version,
          "http": node!.url
        }
      },
      "defaultNode": "local"
    };
    node!.status = ViteNodeStatus.Syncing;
    this._onDidChangeNode.fire(node!);
    return this.localNodePid;
  }

  public async stopLocalViteNode() {
    const node = this.ctx.getViteNode("local");
    delete node?.error;
    node!.status = ViteNodeStatus.Stopped;

    this.postMessage({
      command: "updateViteNode",
      message: node,
    });

    this._onDidChangeNode.fire(node!);
    await this.localNodePid.stop();
  }

  private async updateSnapshotChainHeight(): Promise<void> {
    for (const node of this.ctx.getViteNodesList()) {
      if (this.requestingSet.has(node.name)) {
        return;
      }
      if (node.network === ViteNetwork.Bridge) {
        // TODO: vite connect not supported yet
      } else if (node.status === ViteNodeStatus.Running || node.status === ViteNodeStatus.Syncing) {
        // prevent blocking requests
        setTimeout(async() => {
          try {
            const provider = this.ctx.getProvider(node.name);
            this.requestingSet.add(node.name);
            const height = await provider.request("ledger_getSnapshotChainHeight");
            this.requestingSet.delete(node.name);
            if (node.status === ViteNodeStatus.Syncing) {
              node.status = ViteNodeStatus.Running;
              await this.postMessage({
                command: "updateViteNode",
                message: node,
              });
              this._onDidChangeNode.fire(node);
            }
            await this.postMessage({
              command: "updateSnapshotChainHeight",
              message: {
                nodeName: node.name,
                height,
              },
            });
          } catch (error: any) {
            this.ctx.log.debug("[request]", node.url, "[response]", error);
            this.requestingSet.delete(node.name);
            node.status = ViteNodeStatus.Timeout;
            if (error.code) {
              node.error = error;
            } else {
              node.error = error.message;
            }
            await this.postMessage({
              command: "updateViteNode",
              message: node,
            });
            this._onDidChangeNode.fire(node);
          }
        }, 0);
      }
    }
  }
  public updateDeps() {
    return this.postMessage({
      command: "setViteNode",
      message: {
        viteNodesList: this.ctx.getViteNodesList(),
      },
    });
  }
}