import * as vscode from "vscode";

import { Config } from "./config";
import { Ctx } from "./ctx";
import { activateTaskProvider } from "./task";
import { activateCodeActionProvider } from "./code_action";
import { activateCompleteProvider } from "./complete";
import { activateContractView } from "./view";
import * as commands from "./commands";

export async function activate(context: vscode.ExtensionContext) {
  const config = new Config(context);
  const ctx = await Ctx.create(config, context);
  
  // deploy webiew
  activateContractView(ctx);

  // Add tasks
  activateTaskProvider(ctx);

  // Add codeAction
  activateCodeActionProvider(ctx);

  // Add complete
  activateCompleteProvider(ctx);

  // Actually ABI file is json format
  await vscode.workspace.getConfiguration().update("files.associations", {"*.abi": "json"}, vscode.ConfigurationTarget.Workspace);
  
  // create a temporary textDocument to show some long messages
  const tempTextProvider = new class implements vscode.TextDocumentContentProvider {
		onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
		onDidChange = this.onDidChangeEmitter.event;

		provideTextDocumentContent(uri: vscode.Uri): string {
			return uri.query;
		}
	};

  ctx.pushCleanup(vscode.workspace.registerTextDocumentContentProvider("text", tempTextProvider));

  ctx.registerCommand("stake", commands.stakeForQuota);

  ctx.registerCommand("load", commands.loadContract);

  ctx.registerCommand("faucet", commands.testNetFaucet);

  ctx.registerCommand("getPublicKey", commands.getPublicKey);

  ctx.registerCommand("getPrivateKey", commands.getPrivateKey);

  ctx.registerCommand("getStakeList", commands.getStakeList);
}

export async function deactivate() {
}