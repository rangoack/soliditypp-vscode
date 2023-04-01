import * as vscode from "vscode";
const vite = require("@vite/vitejs");
import { Ctx } from "../ctx";
import { getAmount, waitFor, arrayify } from "../util";
import { getWebviewContent } from "./webview";
import {
  MessageEvent,
  DeployInfo,
  ViteNetwork,
  Address,
  ViteNodeStatus,
  ABIItem,
} from "../types/types";

export class ContractConsoleViewPanel {
  public static currentPanel: ContractConsoleViewPanel | undefined;
  public static readonly viewType = 'contractConsoleView';
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  private static _onDidDispose = new vscode.EventEmitter<void>();
  static readonly onDidDispose: vscode.Event<void> = this._onDidDispose.event;

  private static _onDidCallContract = new vscode.EventEmitter<any>();
  static readonly onDidCallContract: vscode.Event<any> = this._onDidCallContract.event;

  private currentNetwork: ViteNetwork = ViteNetwork.DebugNet;
  private deployeInfoMap: Map<Address, DeployInfo> = new Map();

  private constructor(panel: vscode.WebviewPanel, private readonly ctx: Ctx, deployInfo: DeployInfo) {
    this._panel = panel;

    this._panel.onDidDispose(this.dispose, this, this._disposables);
    this._panel.onDidDispose(() => {
      ContractConsoleViewPanel._onDidDispose.fire();
    }, null, this._disposables);

    this._panel.webview.onDidReceiveMessage(async (event: MessageEvent) => {
      if (event.command !== "log") {
        this.ctx.log.debug(`[receivedMessage=${this.constructor.name}]`, event);
      }
      switch (event.command) {
        case "log":
          const method = event.subCommand as "info" | "debug" | "warn" | "error" | "log";
          const msg: [unknown, ...unknown[]] = event.message;
          this.ctx.log[method](...msg);
          break;

        case "mounted":
          {
            await this.postMessage({
              command: "viewStyle",
              message: this.ctx.config.consoleViewStyle,
            });
            this.updateContractMap(deployInfo);
          }
          break;
        case "getAddressList":
          await this.updateAddressList();
          break;
        case "send":
          {
            const { fromAddress, toAddress, network, abiItem, contractFile } = event.message;
            const contractName = contractFile.fragment;
            // create AccountBlock
            const ab = new vite.accountBlock.AccountBlock({
              blockType: vite.constant.BlockType.TransferRequest,
              address: fromAddress,
              toAddress,
              tokenId: vite.constant.Vite_TokenId,
              amount: abiItem.amount,
              data: "",
            });
            this.ctx.vmLog.info(`[${network}][${contractName}][send()][from=${fromAddress}][to=${toAddress}][amount=${abiItem.amount}]`, ab.accountBlock);
            // get provider
            let provider = this.ctx.getProviderByNetwork(network);
            if (this.ctx.bridgeNode.status === ViteNodeStatus.Connected) {
              const addressList = this.ctx.getAddressList(ViteNetwork.Bridge);
              if (addressList.includes(fromAddress)) {
                provider = this.ctx.getProviderByNetwork(ViteNetwork.Bridge);
              }
            }
            // request provider only for request
            let reqProvider: any;
            if (network === ViteNetwork.Bridge) {
              reqProvider = this.ctx.getProviderByNetwork(ctx.bridgeNode.backendNetwork!);
            } else {
              reqProvider = provider;
            }

            let sendBlock: any;
            if (network === ViteNetwork.Bridge) {
              try {
                sendBlock = await provider.sendCustomRequest({
                  method: "vite_signAndSendTx",
                  params: [{
                    block: ab.accountBlock,
                  }]
                });
                this.ctx.vmLog.info(`[${network}][${contractName}][send()][sendBlock=${sendBlock.hash}]`, sendBlock);
                this.postMessage({
                  command: "callResult",
                  message: {
                    abiItem,
                    contractAddress: toAddress,
                    sendBlock,
                  }
                });
              } catch (error: any) {
                this.ctx.vmLog.error(`[${network}][${contractName}][send()][sendBlock=${sendBlock.hash}]`, sendBlock, error);
                this.postMessage({
                  command: "callResult",
                  message: {
                    abiItem,
                    contractAddress: toAddress,
                    sendBlock,
                    errorMessage: error.message,
                  }
                });
              }
            } else {
              // set provider
              ab.setProvider(provider);
              // set private key
              const addressObj = this.ctx.getAddressObj(fromAddress);
              ab.setPrivateKey(addressObj!.privateKey);
              try {
                // sign and send
                sendBlock = await ab.autoSend();
                // get account block
                await waitFor(async () => {
                  const blocks = await provider.request("ledger_getAccountBlocksByAddress", fromAddress, 0, 3);
                  for (const block of blocks) {
                    if (block.previousHash === sendBlock.previousHash) {
                      sendBlock = block;
                      this.ctx.vmLog.info(`[${network}][${contractName}][send()][sendBlock=${sendBlock.hash}]`, sendBlock);
                      this.postMessage({
                        command: "callResult",
                        message: {
                          abiItem,
                          contractAddress: toAddress,
                          sendBlock,
                        }
                      });
                      return true;
                    }
                  }
                  return false;
                });
              } catch (error: any) {
                this.ctx.vmLog.info(`[${network}][${contractName}][send()][sendBlock=${sendBlock.hash}]`, sendBlock, error);
                this.postMessage({
                  command: "callResult",
                  message: {
                    abiItem,
                    contractAddress: toAddress,
                    sendBlock,
                    errorMessage: error.message,
                  }
                });
              }
            }

            await this.waitingBlockConfirm(reqProvider, network, contractName, toAddress, sendBlock, abiItem, "callResult");

            await this.updateAddressList();
            await this.updateContractQuota();
            ContractConsoleViewPanel._onDidCallContract.fire(event);
          }
          break;
        case "query":
          {
            const { fromAddress, toAddress, network, contractFile, abiItem } = event.message;
            const contractName = contractFile.fragment;
            this.ctx.vmLog.info(`[${network}][${contractName}][query ${abiItem.name}()][request]`, {
              contractAddress: toAddress,
              abiItem,
            });
            // get provider
            let reqProvider: any;
            if (network === ViteNetwork.Bridge) {
              reqProvider = this.ctx.getProviderByNetwork(this.ctx.bridgeNode.backendNetwork!);
            } else {
              reqProvider = this.ctx.getProviderByNetwork(network);
            }

            try {
              // get inputs value
              const inputValues = abiItem.inputs.map((x: any) => x.value);
              const data = vite.abi.encodeFunctionCall(abiItem, inputValues, abiItem.name);

              // query
              const rawRet = await reqProvider.request("contract_query", {
                address: toAddress,
                data: Buffer.from(data, "hex").toString("base64"),
              });
              // FIXME: Unable to get an array of objects.
              this.ctx.vmLog.debug('rawRet', rawRet);
              if (rawRet) {
                const ret = vite.abi.decodeFunctionOutput(
                  abiItem,
                  // abi.outputs.map((x: any)=>x.type),
                  Buffer.from(rawRet, "base64").toString("hex"),
                );
                this.ctx.vmLog.info(`[${network}][${contractName}][query ${abiItem.name}()][response]`, ret);
                this.postMessage({
                  command: "queryResult",
                  message: {
                    ret,
                    abiItem,
                    contractAddress: toAddress,
                  }
                });
                await this.updateAddressList();
                await this.updateContractQuota();
              }
            } catch (error: any) {
              this.ctx.vmLog.error(`[${network}][${contractName}][query ${abiItem.name}()][response]`, error);
              this.postMessage({
                command: "queryResult",
                message: {
                  abiItem,
                  contractAddress: toAddress,
                  errorMessage: error.message,
                }
              });
            }
            ContractConsoleViewPanel._onDidCallContract.fire(event);
          }
          break;
        case "call":
          {
            const { fromAddress, toAddress, network, contractFile, abiItem } = event.message;
            const contractName = contractFile.fragment;
            this.ctx.vmLog.info(`[${network}][${contractName}][call ${abiItem.name}()][request]`, {
              contractAddress: toAddress,
              abiItem,
            });

            // get provider
            let provider = this.ctx.getProviderByNetwork(network);
            if (this.ctx.bridgeNode.status === ViteNodeStatus.Connected) {
              const addressList = this.ctx.getAddressList(ViteNetwork.Bridge);
              if (addressList.includes(fromAddress)) {
                provider = this.ctx.getProviderByNetwork(ViteNetwork.Bridge);
              }
            }
            // request provider only for request
            let reqProvider: any;
            if (network === ViteNetwork.Bridge) {
              reqProvider = this.ctx.getProviderByNetwork(ctx.bridgeNode.backendNetwork!);
            } else {
              reqProvider = provider;
            }

            // create account block
            let ab: any = undefined;
            try {
              // get amount
              const amount = getAmount(abiItem.amount, abiItem.amountUnit ?? "VITE");

              // get inputs value
              const inputValues = abiItem.inputs.map((x: any) => x.value);
              const data = vite.abi.encodeFunctionCall(abiItem, inputValues, abiItem.name);

              ab = new vite.accountBlock.AccountBlock({
                blockType: vite.constant.BlockType.TransferRequest,
                address: fromAddress,
                toAddress,
                tokenId: vite.constant.Vite_TokenId,
                amount,
                fee: '0',
                data: Buffer.from(data, "hex").toString("base64"),
              });
            } catch (error: any) {
              this.ctx.vmLog.error(`[${network}][${contractName}][call ${abiItem.name}()][request]`, {
                contractAddress: toAddress,
                abiItem,
              }, error);
            }

            // send block
            let sendBlock: any;
            if (network === ViteNetwork.Bridge) {
              try {
                sendBlock = await provider.sendCustomRequest({
                  method: "vite_signAndSendTx",
                  params: [{
                    block: ab.accountBlock,
                    abi: abiItem,
                  }]
                });
                this.ctx.vmLog.info(`[${network}][${contractName}][call ${abiItem.name}()][sendBlock=${sendBlock.hash}]`, sendBlock);
                this.postMessage({
                  command: "callResult",
                  message: {
                    abiItem,
                    contractAddress: toAddress,
                    sendBlock,
                  }
                });
              } catch (error: any) {
                this.ctx.vmLog.error(`[${network}][${contractName}][call ${abiItem.name}()][sendBlock=${sendBlock.hash}]`, sendBlock, error);
                this.postMessage({
                  command: "callResult",
                  message: {
                    abi: abiItem,
                    contractAddress: toAddress,
                    sendBlock,
                    errorMessage: error.message,
                  }
                });
                return;
              }
            } else {
              // set provider
              ab.setProvider(provider);
              // set private key
              const addressObj = this.ctx.getAddressObj(fromAddress);
              ab.setPrivateKey(addressObj!.privateKey);
              try {
                // sign and send
                sendBlock = await ab.autoSend();
                this.ctx.vmLog.info(`[${network}][${contractName}][call ${abiItem.name}()][sendBlock=${sendBlock.hash}]`, sendBlock);
                this.postMessage({
                  command: "callResult",
                  message: {
                    abiItem,
                    contractAddress: toAddress,
                    sendBlock,
                  }
                });
              } catch (error: any) {
                this.ctx.vmLog.error(`[${network}][${contractName}][call ${abiItem.name}()][sendBlock=${sendBlock.hash}]`, sendBlock, error);
                this.postMessage({
                  command: "callResult",
                  message: {
                    abiItem,
                    contractAddress: toAddress,
                    sendBlock,
                    errorMessage: error.message
                  }
                });
                return;
              }
            }

            await this.waitingBlockConfirm(reqProvider, network, contractName, toAddress, sendBlock, abiItem, "callResult");

            await this.updateAddressList();
            await this.updateContractQuota();

            ContractConsoleViewPanel._onDidCallContract.fire(event);
          }
          break;
      }
    }, null, this._disposables);

    this._panel.webview.html = getWebviewContent(this._panel.webview, ctx.extensionUri, "console");
  }

  public static render(ctx: Ctx, deployInfo: DeployInfo) {
    const column = ctx.config.consoleViewColumn ?? vscode.ViewColumn.One;

    if (ContractConsoleViewPanel.currentPanel) {
      ContractConsoleViewPanel.currentPanel._panel.reveal(column, true);
      ContractConsoleViewPanel.currentPanel._panel.title = `${deployInfo.contractName} Console`;
      ContractConsoleViewPanel.currentPanel.updateContractMap(deployInfo);
    } else {
      const panel = vscode.window.createWebviewPanel(
        ContractConsoleViewPanel.viewType,
        `${deployInfo.contractName} Console`,
        {
          viewColumn: column,
          preserveFocus: true,
        },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        }
      );
      panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, "assets", "dashboard.svg");

      ContractConsoleViewPanel.currentPanel = new ContractConsoleViewPanel(panel, ctx, deployInfo);
    }
  }
  
  private async waitingBlockConfirm(reqProvider: any, network: ViteNetwork, contractName: string, contractAddress: Address, sendBlock: any, abiItem: ABIItem, command: string): Promise<void> {
    // waiting sendBlock confirm
    try {
      let isSendBlockConfirmed = false;
      await waitFor(async () => {
        sendBlock = await reqProvider.request("ledger_getAccountBlockByHash", sendBlock.hash);
        if (sendBlock.confirmedHash && !isSendBlockConfirmed) {
          this.ctx.vmLog.info(`[${network}][${contractName}][call ${abiItem.name}()][sendBlock][confirmed=${sendBlock.confirmedHash}]`, sendBlock);
          isSendBlockConfirmed = true;
          // update sendBlock confirmedHash
          this.postMessage({
            command,
            message: {
              abiItem,
              contractAddress,
              sendBlock,
            }
          });
        }
        // wating receiveBlockHash
        if (!sendBlock.confirmedHash || !sendBlock.receiveBlockHash) {
          return false;
        }
        this.postMessage({
          command,
          message: {
            abiItem,
            contractAddress,
            sendBlock,
          }
        });
        return true;
      }, 500, 75 * 1000);
    } catch (error: any) {
      this.ctx.vmLog.error(`[${network}][${contractName}][call ${abiItem.name}()][sendBlock=${sendBlock.hash}]`, sendBlock, error);
      this.postMessage({
        command: command,
        message: {
          abiItem,
          contractAddress,
          sendBlock,
          errorMessage: error.message
        }
      });
      return;
    }

    // get receiveBlock first
    let receiveBlock: any;
    try {
      receiveBlock = await reqProvider.request("ledger_getAccountBlockByHash", sendBlock.receiveBlockHash);
      this.ctx.vmLog.info(`[${network}][${contractName}][call ${abiItem.name}()][receiveBlock=${receiveBlock.hash}]`, receiveBlock);
      this.postMessage({
        command,
        message: {
          abiItem,
          contractAddress,
          sendBlock,
          receiveBlock,
        }
      });
    } catch (error) {}

    // waiting receiveBlock confirm
    try {
      await waitFor(async () => {
        receiveBlock = await reqProvider.request("ledger_getAccountBlockByHash", receiveBlock.hash);
        if (!receiveBlock.confirmedHash) {
          return false;
        } else {
          this.ctx.vmLog.info(`[${network}][${contractName}][call ${abiItem.name}()][receiveBlock][confirmed=${receiveBlock.confirmedHash}]`, receiveBlock);
          this.postMessage({
            command,
            message: {
              abiItem,
              contractAddress,
              sendBlock,
              receiveBlock,
            }
          });
          return true;
        }
      });
    } catch (error:any) {
      this.ctx.vmLog.error(`[${network}][${contractName}][call ${abiItem.name}()][receiveBlock=${receiveBlock.hash}]`, receiveBlock, error);
      this.postMessage({
        command,
        message: {
          abiItem,
          contractAddress,
          sendBlock,
          receiveBlock,
          errorMessage: error.message
        }
      });
      return;
    }

    // check hash block correctly.
    let error: Error | undefined = undefined;
    if (receiveBlock.blockType !== 4 && receiveBlock.blockType !== 5 || !receiveBlock.data) {
      error = new Error("Bad receive block");
    }
    const receiveBlockDataBytes = Buffer.from(receiveBlock.data, "base64");
    if (receiveBlockDataBytes.length !== 33) {
      error = new Error("Bad data in receive block");
    }
    // parse error code from data in receive block
    const errorCode = receiveBlockDataBytes[32];
    switch (errorCode) {
      case 1:
        error = new Error("Revert");
        break;
      case 2:
        error = new Error("Maximum call stack size exceeded");
        break;
    }
    if (error !== undefined) {
      this.ctx.vmLog.error(`[${network}][${contractName}][call ${abiItem.name}()][receiveBlock=${receiveBlock.hash}]`, receiveBlock, error);
      this.postMessage({
        command,
        message: {
          abiItem,
          contractAddress,
          sendBlock,
          receiveBlock,
          errorMessage: error.message,
        }
      });
    }
  }

  public static updateDeps(){
    if (ContractConsoleViewPanel.currentPanel) {
      ContractConsoleViewPanel.currentPanel.updateAddressList();
      ContractConsoleViewPanel.currentPanel.updateContractQuota();
    }
  }

  public async updateAddressList() {
    let addressList: Address[];
    if (this.currentNetwork === ViteNetwork.Bridge) {
      addressList = [...this.ctx.getAddressList(this.currentNetwork), ...this.ctx.getAddressList(this.ctx.bridgeNode.backendNetwork!)];
    } else {
      if (this.ctx.bridgeNode.backendNetwork === this.currentNetwork && this.ctx.bridgeNode.status === ViteNodeStatus.Connected) {
        addressList = [...this.ctx.getAddressList(this.currentNetwork), ...this.ctx.getAddressList(ViteNetwork.Bridge)];
      } else {
        addressList = this.ctx.getAddressList(this.currentNetwork);
      }
    }
    // const addressList = this.ctx.getAddressList(this.currentNetwork);
    let provider;
    if (this.currentNetwork === ViteNetwork.Bridge) {
      provider = this.ctx.getProviderByNetwork(this.ctx.bridgeNode.backendNetwork!);
    } else {
      provider = this.ctx.getProviderByNetwork(this.currentNetwork);
    }
    const message: any[] = [];
    for (const address of addressList) {
      const quotaInfo = await provider.request("contract_getQuotaByAccount", address);
      this.ctx.log.debug('get quota', quotaInfo);
      const balanceInfo = await provider.getBalanceInfo(address);
      this.ctx.log.debug('get balance', balanceInfo);
      const balance = balanceInfo.balance.balanceInfoMap?.[vite.constant.Vite_TokenId]?.balance;
      message.push({
        address,
        network: this.currentNetwork,
        quota: quotaInfo.currentQuota,
        balance: balance ? balance.slice(0, balance.length - vite.constant.Vite_Token_Info.decimals) : '0',
      });
    }
    this.postMessage({
      command: "setAddressList",
      message,
    });
  }

  public async updateContractQuota() {
    try {
      const provider = this.ctx.getProviderByNetwork(this.currentNetwork);
      for (const address of this.deployeInfoMap.keys()) {
        const quotaInfo = await provider.request("contract_getQuotaByAccount", address);
        this.postMessage({
          command: "updateContractQuota",
          message: {
            contractAddress: address,
            quota: quotaInfo.currentQuota,
          }
        });
      }
    } catch (error) {
      this.ctx.vmLog.error(`[${this.currentNetwork}][getQuota]`, error);
    }
  }

  private clear() {
    this.deployeInfoMap.clear();
    let provider;
    if (this.currentNetwork === ViteNetwork.Bridge) {
      provider = this.ctx.getProviderByNetwork(this.ctx.bridgeNode.backendNetwork!);
    } else {
      provider = this.ctx.getProviderByNetwork(this.currentNetwork);
    }
    provider.unsubscribeAll();
  }

  public async updateContractMap(deployInfo: DeployInfo) {
    if (this.currentNetwork !== deployInfo.network) {
      this.clear();
      this.postMessage({
        command: "clear",
      });
      this.currentNetwork = deployInfo.network;
    }

    if (!this.deployeInfoMap.has(deployInfo.address)) {
      // store to map
      this.deployeInfoMap.set(deployInfo.address, deployInfo);

      // subscribe vm log
      this.subscribeVmLog(deployInfo);
    }

    // push to webview
    await this.postMessage({
      command: "pushContract",
      message: deployInfo,
    });

    // query contract quota
    this.updateContractQuota();
  }

  private async subscribeVmLog(deployInfo: DeployInfo) {
    let provider;
    if (deployInfo.network === ViteNetwork.Bridge) {
      provider = this.ctx.getProviderByNetwork(this.ctx.bridgeNode.backendNetwork!);
    } else {
      provider = this.ctx.getProviderByNetwork(deployInfo.network);
    }

    // subscribe vmlog
    try {
      this.ctx.vmLog.info(`[${deployInfo.network}][${deployInfo.contractName}][subscribe][newVmLog=${deployInfo.address}]`);
      const listener = await provider.subscribe("newVmLog", {
        "addressHeightRange":{
          [deployInfo.address]:{
            "fromHeight":"0",
            "toHeight":"0"
          }
        }
      });
      listener.on(async (events: any[]) => {
        for (const event of events) {
          this.ctx.vmLog.info(`[${deployInfo.network}][${deployInfo.contractName}][subscribe][newVmLog=${deployInfo.address}]`, event);
          const topics = event.vmlog?.topics;
          for (let abiItem of deployInfo.abi) {
            let signature = vite.abi.encodeLogSignature(abiItem);
            if (abiItem.type === "event" && signature === topics[0]) { 
              let dataHex;
              if (event.vmlog.data) {
                dataHex = Buffer.from(event.vmlog.data, "base64").toString("hex");
              }
              let ret = vite.abi.decodeLog(
                abiItem,
                dataHex,
                topics
              );
              this.postMessage({
                command: "eventResult",
                message: {
                  ret,
                  abiItem,
                  contractAddress: deployInfo.address,
                }
              });
              this.ctx.vmLog.info(`[${deployInfo.network}][${deployInfo.contractName}][subscribe][newVmLog=${deployInfo.address}][decode]`, ret);
            }
          }
        }
      });

    } catch (error) {
      this.ctx.vmLog.error(`[${deployInfo.network}][subscribe][newVmLog=${deployInfo.contractName}]`, error);
    }
  }

  public async postMessage(message: any): Promise<boolean> {
    this.ctx.log.debug(`[postMessage=${this.constructor.name}]`, message);
    if (this._panel) {
      return this._panel.webview.postMessage(message);
    } else {
      this.ctx.log.debug(this.constructor.name, "webviewView is null");
      return false;
    }
  }

  public dispose() {
    this.clear();

    ContractConsoleViewPanel.currentPanel = undefined;

    this._panel.dispose();

    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  public get webViewPanel(): vscode.WebviewPanel {
    return this._panel;
  }
}