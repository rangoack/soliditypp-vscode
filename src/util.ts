import * as vscode from "vscode";
import * as path from "path";
import { strict as nativeAssert } from "assert";
import { spawnSync } from "child_process";
import { inspect } from "util";
import BigNumber from "bignumber.js";

const VITE_DECIMAL = new BigNumber('1e18');

export function assert(condition: boolean, explanation: string): asserts condition {
  try {
    nativeAssert(condition, explanation);
  } catch (err) {
    log.error(`Assertion failed:`, explanation);
    throw err;
  }
}

export class Log {
  protected enabled = true;
  protected readonly output: vscode.OutputChannel;

  constructor(outputName: string) {
    this.output = vscode.window.createOutputChannel(outputName, "log");
  }

  setEnabled(yes: boolean): void {
    this.enabled = yes;
  }

  debug(...msg: [unknown, ...unknown[]]): void {
    /* eslint-disable-next-line */
    if (!this.enabled) return;
    this.write("DEBUG", ...msg);
  }

  info(...msg: [unknown, ...unknown[]]): void {
    this.write("INFO", ...msg);
  }

  warn(...msg: [unknown, ...unknown[]]): void {
    // debugger;
    this.write("WARN", ...msg);
  }

  error(...msg: [unknown, ...unknown[]]): void {
    // debugger;
    this.write("ERROR", ...msg);
    this.output.show(true);
  }

  log(...msg: [unknown, ...unknown[]]): void {
    const message = msg.map(this.stringify).join(" ");
    this.output.appendLine(`${message}`);
  }

  protected write(label: string, ...messageParts: unknown[]): void {
    const message = messageParts.map(this.stringify).join(" ");
    const dateTime = new Date().toLocaleString();
    this.output.appendLine(`${label} [${dateTime}]: ${message}`);
  }

  private stringify(val: unknown): string {
    /* eslint-disable-next-line */
    if (typeof val === "string") return val;
    return inspect(val, {
      colors: false,
      depth: 6, // heuristic
    });
  }
}

export const log = new Log("Solidity++ Debugger Client");

class VmLog extends Log {
  error(...msg: [unknown, ...unknown[]]): void {
    if (this.enabled) {
      this.write("ERROR", ...msg);
    } else {
      this.write("ERROR", ...(msg.map(x => x instanceof Error ? x.message : x)));
    }
    this.output.show(true);
  }
}

export const vmLog = new VmLog("VITE VM Log");

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type SolppDocument = vscode.TextDocument & { languageId: "soliditypp" };
export type SolppEditor = vscode.TextEditor & { document: SolppDocument };

export function isSolppFile(file: vscode.Uri): boolean {
  if ([".sol", ".solpp"].includes(path.extname(file.fsPath))) {
    return true;
  }
  return false;
}

export function isSolppDocument(document: vscode.TextDocument): document is SolppDocument {
  return document.languageId === "soliditypp" && document.uri.scheme === "file";
}

export function isSolppEditor(editor: vscode.TextEditor): editor is SolppEditor {
  return isSolppDocument(editor.document);
}

export function isValidExecutable(path: string): boolean {
  log.debug("Checking availability of a binary at", path);

  const res = spawnSync(path, ["--version"], { encoding: "utf8"});

  const printOutput = res.error && (res.error as any).code !== "ENOENT" ? log.warn : log.debug;
  printOutput(path, "--version:", res);

  return res.status === 0;
}

/**
 * Returns a higher-order function that caches the results of invoking the
 * underlying async function.
 */
export function memoizeAsync<Ret, TThis, Param extends string>(
  func: (this: TThis, arg: Param) => Promise<Ret>
) {
  const cache = new Map<string, Ret>();

  return async function (this: TThis, arg: Param) {
    const cached = cache.get(arg);
    /* eslint-disable-next-line */
    if (cached) return cached;

    const result = await func.call(this, arg);
    cache.set(arg, result);

    return result;
  };
}

export async function readContractJsonFile(file: vscode.Uri): Promise<any> {
  file = file.with({ scheme: "file" });
  const ret: Uint8Array = await vscode.workspace.fs.readFile(file);
  const compileResult = JSON.parse(ret.toString());
  let errors;
  if (compileResult.errors) {
    errors = compileResult.errors;
  }
  let contract;
  for (const fileName in compileResult.contracts) {
    const contractObj = compileResult.contracts[fileName];
    for (const contractName in contractObj) {
      if (contractName === file.fragment) {
        contract = contractObj[contractName];
      }
    }
  }
  if (contract) {
    return {
      errors,
      ...contract,
    };
  } else {
    return compileResult;
  }
}

export function getAmount(amount: string | number, unit?:string) {
  if (amount && (unit === undefined || unit.toUpperCase() === "VITE")) {
    return new BigNumber(amount).multipliedBy(VITE_DECIMAL).toFixed();
  } else {
    return amount ? amount.toString() : '0';
  }
}

export function formatAmount(amount: string, unit = "VITE") {
  if (unit.toUpperCase() === "VITE") {
    return new BigNumber(amount).dividedBy(VITE_DECIMAL).toFixed();
  } else {
    return amount;
  }
}

export async function waitFor(condition: () => Promise<boolean>, interval: number = 500, timeout: number = 30 * 1000): Promise<void> {
  const startTime = Date.now();
  while (true) {
    if (await condition()) {
      break;
    }
    if (Date.now() - startTime > timeout) {
      throw new Error(`Timeout waiting for execute reply (${timeout/1000}s)`);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

export function arrayify(value: Buffer | Uint8Array | string | number | bigint): Buffer {
  if (typeof (value) === 'number') {
    if (value < 0 || value >= 0x1fffffffffffff) {
      throw new Error(`invalid arrayify value ${value}`);
    }
    const result = [];
    while (value) {
      result.unshift(value & 0xff);
      value = parseInt(String(value / 256));
    }
    if (result.length === 0) {
      result.push(0);
    }

    return Buffer.from(result);
  }
  if (typeof (value) === 'bigint') {
    if (value < 0) {
      throw new Error(`invalid arrayify value ${value}`);
    }
    value = value.toString(16);
    if (value.length % 2) {
      value = `0${value}`;
    }
    return Buffer.from(value.toString(), 'hex');
  }
  if (typeof (value) === 'string') {
    if (value.substring(0, 2) === '0x') {
      value = value.substring(2);
    }
    if (isHexString(value)) {
      if (value.length % 2) {
        value = `0${value}`;
      }
      return Buffer.from(value.toString(), 'hex');
    }
    throw new Error(`not hex string ${value}`);
  }

  if (Buffer.isBuffer(value) || (value as any).constructor === Uint8Array) {
    // return Buffer.alloc(value.length, value);
    return Buffer.from(value);
  }

  throw new Error(`invalid arrayify value ${value}`);
}

export function isHexString(str: string, length?: number): boolean {
  // return /^[0-9a-fA-F]+$/.test(str);
  if (typeof (str) !== 'string' || !str.match(/^[0-9A-Fa-f]*$/)) {
    return false;
  }
  if (length && str.length !== 2 * length) {
    return false;
  }
  return true;
}