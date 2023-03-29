import * as vscode from "vscode";
const vuilder = require("@vite/vuilder");
const vite = require("@vite/vitejs");
import { Ctx, Cmd } from "./ctx";
import { Address, ViteNetwork, DeployInfo } from "./types/types";
import { getAmount, waitFor } from "./util";
import { ContractConsoleViewPanel } from "./view/contract_console";

export function stake(ctx: Ctx): Cmd {
  return async () => {
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
    const fromAddressObj = ctx.getAddressObj(fromAddress);
    if (!fromAddressObj) {
      ctx.vmLog.error(`[${selectedNetwork}][stake]${fromAddress} is not found in the wallet`);
      return;
    }

    ctx.vmLog.info(`[${selectedNetwork}][stake][request]`, {
      fromAddress,
      beneficiaryAddress,
      amount,
      network: selectedNetwork,
    });
    // get provider and operator
    const provider = ctx.getProviderByNetwork(selectedNetwork);
    const sender = new vuilder.UserAccount(fromAddress);
    sender._setProvider(provider);
    sender.setPrivateKey(fromAddressObj.privateKey);
    let sendBlock = sender.stakeForQuota({
      beneficiaryAddress,
      amount: getAmount(amount),
    });

    let resend = false;
    try {
      sendBlock = await sendBlock.autoSendByPoW();
    } catch (error) {
      ctx.vmLog.error(`[${selectedNetwork}][stake][autoSendByPoW]`, error);
      resend = true;
    }

    try {
      if (resend) {
        sendBlock = await sendBlock.autoSend();
      }
      ctx.vmLog.info(`[${selectedNetwork}][stake][sendBlock=${sendBlock.hash}]`, sendBlock);

      // get account block
      await waitFor(async () => {
        const blocks = await provider.request("ledger_getAccountBlocksByAddress", fromAddress, 0, 3);
        for (const block of blocks) {
          if (block.previousHash === sendBlock.previousHash) {
            sendBlock = block;
            ctx.vmLog.info(`[${selectedNetwork}][stake][sendBlock=${sendBlock.hash}]`, sendBlock);
            return true;
          }
        }
        return false;
      });

      // waiting confirmed
      await waitFor(async () => {
        sendBlock = await provider.request("ledger_getAccountBlockByHash", sendBlock.hash);
        if (!sendBlock.confirmedHash || !sendBlock.receiveBlockHash) {
          return false;
        }
        ctx.vmLog.info(`[${selectedNetwork}][stake][sendBlock][confirmed=${sendBlock.confirmedHash}]`, sendBlock);
        return true;
      });

      // waiting confirmed
      await waitFor(async () => {
        // get receive block
        const receiveBlock = await provider.request("ledger_getAccountBlockByHash", sendBlock.receiveBlockHash);
        if (!receiveBlock.confirmedHash) {
          return false;
        }
        ctx.vmLog.info(`[${selectedNetwork}][stake][receiveBlock][confirmed=${receiveBlock.confirmedHash}]`, receiveBlock);
        return true;
      });
      // refresh Wallet
      vscode.window.showInformationMessage(`The stake has confirmed. The beneficiary address(${beneficiaryAddress.slice(-4)}) will receive the quota`);
      await vscode.commands.executeCommand("soliditypp.refreshWallet");
    } catch (error: any) {
      vscode.window.showErrorMessage("An error occurred in stake for quota.");
      ctx.vmLog.error(`[${selectedNetwork}][stake]`, error);
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
