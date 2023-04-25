import * as vscode from "vscode";
const vite = require("@vite/vitejs");
import { Ctx, Cmd } from "./ctx";
import { Address, ViteNetwork, DeployInfo, AddressObj, ViteNodeStatus } from "./types/types";
import { getAmount, waitFor } from "./util";
import { ContractConsoleViewPanel } from "./view/contract_console";

const stakeForQuotaAbi = vite.constant.Contracts.StakeForQuota.abi;
const stakeForQuotaContractAddress = vite.constant.Contracts.StakeForQuota.contractAddress;

export function stakeForQuota(ctx: Ctx): Cmd {
  return async () => {
    let selectedNetwork: ViteNetwork | null = null;
    await vscode.window.showInputBox({
      ignoreFocusOut: true,
      placeHolder: "Debug | TestNet | MainNet | Bridge",
      prompt: "Please input the network",
      validateInput: (value: string) => {
        if (value) {
          let found:any;
          for (const network of Object.values(ViteNetwork)) {
            found = network.match(new RegExp(value, "i"));
            if (found) {
              selectedNetwork = network;
              break;
            }
          }
          if (found) {
            return "";
          } else {
            return "Invalid network";
          }
        } else {
          return "";
        }
      }
    });
    if (!selectedNetwork) {
      return;
    }

    const fromAddress = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      value: ctx.getAddressList(selectedNetwork)[0],
      placeHolder: "Deduction Address",
      prompt: "Please input the address to stake from",
      validateInput: (value: string) => {
        if (vite.wallet.isValidAddress(value) !== 1) {
          return "Please input a valid address";
        } else {
          return "";
        }
      }
    });
    if (!fromAddress) {
      return;
    };
    const beneficiaryAddress: Address | undefined = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      value: ctx.getAddressList(selectedNetwork)[0],
      placeHolder: "Quota Beneficiary",
      prompt: "Input the address to stake to",
      validateInput: (value: string) => {
        if (vite.wallet.isValidAddress(value) > 0) {
          return "";
        } else {
          return "Please input a valid address";
        }
      }
    });
    if (!beneficiaryAddress) {
      return;
    };
    let amount = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      placeHolder: "The minimum staking amount is 134 VITE",
      prompt: "Input the amount to stake",
    });
    if (!amount) {
      return;
    };

    ctx.vmLog.info(`[${selectedNetwork}][stakeForQuota]][request]`, {
      fromAddress,
      beneficiaryAddress,
      amount,
      network: selectedNetwork,
    });

    // get provider
    let provider = ctx.getProviderByNetwork(selectedNetwork);
    // request provider only for request
    let reqProvider: any;
    if (selectedNetwork === ViteNetwork.Bridge) {
      reqProvider = ctx.getProviderByNetwork(ctx.bridgeNode.backendNetwork!);
    } else {
      reqProvider = provider;
    }

    // create account block
    let ab: any;
    try {
      // get inputs value
      const data = vite.abi.encodeFunctionCall(stakeForQuotaAbi, [beneficiaryAddress], 'StakeForQuota');

      ab = new vite.accountBlock.AccountBlock({
        blockType: vite.constant.BlockType.TransferRequest,
        address: fromAddress,
        toAddress: stakeForQuotaContractAddress,
        tokenId: vite.constant.Vite_TokenId,
        amount: getAmount(amount),
        fee: '0',
        data: Buffer.from(data, "hex").toString("base64"),
      });
    } catch (error: any) {
      vscode.window.showErrorMessage(`stakeForQuota error: ${error.message}`);
      ctx.vmLog.error(`[${selectedNetwork}][stakeForQuota][request]`, {
        contractAddress: stakeForQuotaContractAddress,
        quotaAbi: stakeForQuotaAbi,
      }, error);
    }

    // send block
    let sendBlock: any;
    if (selectedNetwork === ViteNetwork.Bridge) {
      try {
        sendBlock = await provider.sendCustomRequest({
          method: "vite_signAndSendTx",
          params: [{
            block: ab.accountBlock,
            abi: stakeForQuotaAbi,
          }]
        });
        ctx.vmLog.info(`[${selectedNetwork}][stakeForQuota][sendBlock=${sendBlock.hash}]`, sendBlock);
      } catch (error: any) {
        vscode.window.showErrorMessage(`stakeForQuota error: ${error.message}`);
        ctx.vmLog.error(`[${selectedNetwork}][stakeForQuota][sendBlock=${sendBlock.hash}]`, sendBlock, error);
        return;
      }
    } else {
      // set provider
      ab.setProvider(provider);
      // set private key
      const addressObj = ctx.getAddressObj(fromAddress);
      if (!addressObj) {
        ctx.vmLog.error(`[${selectedNetwork}][stakeForQuota]${fromAddress} is not found in the wallet`);
        vscode.window.showErrorMessage(`${fromAddress} is not found in the wallet`);
        return;
      }

      ab.setPrivateKey(addressObj!.privateKey);
      let resend = false;
      try {
        sendBlock = await sendBlock.autoSendByPoW();
      } catch (error) {
        ctx.vmLog.error(`[${selectedNetwork}][stake][autoSendByPoW]`, error);
        resend = true;
      }
      if (resend) {
        try {
          // sign and send
          sendBlock = await ab.autoSend();
          ctx.vmLog.info(`[${selectedNetwork}][stakeForQuota][sendBlock=${sendBlock.hash}]`, sendBlock);
        } catch (error: any) {
          vscode.window.showErrorMessage(`stakeForQuota error: ${error.message}`);
          ctx.vmLog.error(`[${selectedNetwork}][stakeForQuota][sendBlock=${sendBlock.hash}]`, sendBlock, error);
          return;
        }
      }
    }


    try {
      // waiting confirm
      const err = await ctx.waitingBlockConfirm(reqProvider, selectedNetwork, 'stakeForQuota', stakeForQuotaContractAddress, sendBlock, stakeForQuotaAbi);
      if (err) {
        throw err;
      }
      // refresh Wallet
      vscode.commands.executeCommand("soliditypp.refreshWallet");
      vscode.window.showInformationMessage(`The stake has confirmed. The beneficiary address(${beneficiaryAddress.slice(-4)}) will receive the quota`);
    } catch (error: any) {
      vscode.window.showErrorMessage("An error occurred in stake for quota.");
      ctx.vmLog.error(`[${selectedNetwork}][stakeForQuota]`, error);
    }
  };
}

export function loadContract(ctx: Ctx): Cmd {
  return async () => {
    // Step 1: Input a contract name
    const contractNameInput = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      prompt: "Please input the contract name",
    });
    if (!contractNameInput) {
      return;
    }

    // Step 2: Use regex to find the contract from all contract files
    // TODO: same contract name
    const contractFiles = [
      ...(await vscode.workspace.findFiles("**/*.sol", "**/node_modules/**")),
      ...(await vscode.workspace.findFiles("**/*.solpp", "**/node_modules/**")),
    ];
    let selectedContractFile: vscode.Uri | undefined;
    let contractName: string | undefined;
    for (const item of contractFiles) {
      const fileContent = (await vscode.workspace.fs.readFile(item)).toString();
      const regexMatch = fileContent.match(new RegExp(`contract\\s+(${contractNameInput})`, "i"));
      if (regexMatch) {
        selectedContractFile = item;
        contractName = regexMatch[1]; // Update contract name with the correct case
        break;
      }
    }

    if (!contractName || !selectedContractFile) {
      vscode.window.showErrorMessage(`contract ${contractNameInput} is not found`);
      return;
    }

    // Step 3: Check if the contract file was compiled, if not, compile it and read the contract ABI
    const contractJsonFile = vscode.Uri.parse(`${selectedContractFile.fsPath}.json`);
    try {
      await vscode.workspace.fs.stat(contractJsonFile);
    } catch (error) {
      // Compile the contract if not compiled
      await vscode.commands.executeCommand("soliditypp.compile", selectedContractFile);
      // Wait for the compilation to finish
      await waitFor(async () => {
        try {
          await vscode.workspace.fs.stat(contractJsonFile);
          return true;
        } catch (error) {
          return false;
        }
      }, 100);
    }
    let compileResult: any;
    await waitFor(async () => {
      try {
        const ret: Uint8Array = await vscode.workspace.fs.readFile(contractJsonFile);
        compileResult = JSON.parse(ret.toString());
        if (compileResult) {
          return true;
        } else {
          return false;
        }
      } catch (error) {
        return false;
      }
    });

    if (compileResult.errors) {
      vscode.window.showErrorMessage(`Contract ${contractName} is compiled with errors`);
      return;
    }

    const contractObj = compileResult.contracts[vscode.workspace.asRelativePath(selectedContractFile, false)];
    const contract = contractObj[contractName];

    // Step 4: Input network
    let selectedNetwork: ViteNetwork | null = null;
    await vscode.window.showInputBox({
      ignoreFocusOut: true,
      placeHolder: "Debug | TestNet | MainNet",
      prompt: "Please input the network",
      validateInput: (value: string) => {
        if (value) {
          let found:any;
          for (const network of Object.values(ViteNetwork)) {
            found = network.match(new RegExp(value, "i"));
            if (found) {
              selectedNetwork = network;
              break;
            }
          }
          if (found) {
            return "";
          } else {
            return "Invalid network";
          }
        } else {
          return "";
        }
      }
    });
    if (!selectedNetwork) {
      return;
    }

    // Step 5: Input contract address
    const address = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      prompt: "Please input the contract address",
      validateInput: (value: string) => {
        if (vite.wallet.isValidAddress(value) !== 2) {
          return "Please input a valid address";
        } else {
          return "";
        }
      }
    });
    if (!address) {
      return;
    }

    // Step 6: Construct deploy info and render
    const deployinfo: DeployInfo = {
      contractName,
      address,
      contractFsPath: contractJsonFile.fsPath,
      sourceFsPath: selectedContractFile.fsPath,
      network: selectedNetwork,
      abi: contract.abi,
    };
    ContractConsoleViewPanel.render(ctx, deployinfo);
  };
}

export function testNetFaucet(ctx: Ctx): Cmd {
  return async () => {
    vscode.env.openExternal(vscode.Uri.parse("https://vitefaucet.xyz"));
  };
}

export function getPublicKey(ctx: Ctx): Cmd {
  return async () => {
    await getAddressInfo(ctx, "publicKey");
  };
}

export function getPrivateKey(ctx: Ctx): Cmd {
  return async () => {
    await getAddressInfo(ctx, "privateKey");
  };
}

async function getAddressInfo(ctx: Ctx, infoKey: keyof AddressObj) {
  let selectedNetwork: ViteNetwork | null = null;
  await vscode.window.showInputBox({
    ignoreFocusOut: true,
    placeHolder: "Debug | TestNet | MainNet",
    prompt: "Please input the network",
    validateInput: (value: string) => {
      if (value) {
        let found: any;
        for (const network of Object.values(ViteNetwork)) {
          found = network.match(new RegExp(value, "i"));
          if (found) {
            selectedNetwork = network;
            break;
          }
        }
        if (found) {
          return "";
        } else {
          return "Invalid network";
        }
      } else {
        return "";
      }
    }
  });
  if (!selectedNetwork) {
    return;
  }
  let idx: number = 0;
  await vscode.window.showInputBox({
    ignoreFocusOut: true,
    placeHolder: "The address index",
    prompt: "Please input the publicKey index",
    validateInput: (value: string) => {
      const x = Number(value);
      if (Number.isNaN(x) || x < 0) {
        return "Invalid number";
      } else {
        idx = Number(value);
        return "";
      }
    }
  });
  const wallet = ctx.getWallet(selectedNetwork);
  const addressObj: AddressObj = wallet.deriveAddress(idx);
  vscode.window.showInformationMessage(`${infoKey} for the address[${addressObj.address.slice(-4)}]: \n${addressObj[infoKey]}`);
}

export function getStakeList(ctx: Ctx): Cmd {
  return async () => {
    let selectedNetwork: ViteNetwork | null = null;
    await vscode.window.showInputBox({
      ignoreFocusOut: true,
      placeHolder: "Debug | TestNet | MainNet | Bridge",
      prompt: "Please input the network",
      validateInput: (value: string) => {
        if (value) {
          let found:any;
          for (const network of Object.values(ViteNetwork)) {
            found = network.match(new RegExp(value, "i"));
            if (found) {
              selectedNetwork = network;
              break;
            }
          }
          if (found) {
            return "";
          } else {
            return "Invalid network";
          }
        } else {
          return "";
        }
      }
    });
    if (!selectedNetwork) {
      return;
    }

    const address = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      value: ctx.getAddressList(selectedNetwork)[0],
      placeHolder: "Address of account",
      prompt: "Please input the address of an account",
      validateInput: (value: string) => {
        if (vite.wallet.isValidAddress(value) !== 1) {
          return "Please input a valid address";
        } else {
          return "";
        }
      }
    });
    if (!address) {
      return;
    };
    let skip: string | number | undefined = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      value: "0",
      placeHolder: "Start number of results",
      prompt: "Please input the start number of results",
      validateInput: (value: string) => {
        if (Number.isNaN(parseInt(value))) {
          return "Please input a valid number";
        } else {
          return "";
        }
      }
    });
    if (skip) {
      skip = parseInt(skip);
    } else {
      skip = 0;
    }

    let limit: string | number | undefined = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      value: "10",
      placeHolder: "Number of results",
      prompt: "Please input the number of results",
      validateInput: (value: string) => {
        if (Number.isNaN(parseInt(value))) {
          return "Please input a valid number";
        } else {
          return "";
        }
      }
    });

    if (limit) {
      limit = parseInt(limit);
    } else {
      limit = 0;
    }

    // get provider
    let reqProvider: any;
    if (selectedNetwork === ViteNetwork.Bridge) {
      reqProvider = ctx.getProviderByNetwork(ctx.bridgeNode.backendNetwork!);
    } else {
      reqProvider = ctx.getProviderByNetwork(selectedNetwork);
    }

    try {
      // query
      const ret = await reqProvider.request("contract_getStakeList", address, skip, limit);
      ctx.log.info(`[${selectedNetwork}][getStakeList]`, ret);
      const uri = vscode.Uri.parse(`text:getStakeList [${selectedNetwork}] [${address.slice(-4)}]?${JSON.stringify(ret, null, 2)}`);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (error: any) {
      ctx.log.error(`[${selectedNetwork}][getStakeList]`, error);
    }
  };
}


export function cancelQuotaStake(ctx: Ctx): Cmd {
  return async () => {
  };
}
