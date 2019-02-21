import WsProvider  from '@vite/vitejs/dist/es5/provider/WS';
import * as Vitejs from '@vite/vitejs';
import receiveAllOnroadTx from 'utils/receiveAllOnroadTx';

const VITE_TOKEN_ID = 'tti_5649544520544f4b454e6e40';
const WS_SERVER = 'ws://localhost:23457';
const GENESIS_PRIVATEKEY = '7488b076b27aec48692230c88cbe904411007b71981057ea47d757c1e7f7ef24f4da4390a6e2618bec08053a86a6baf98830430cbefc078d978cf396e1c43e3a';

let viteClient;
let genesisAccount;
let testAccount;

export async function init() {
    let wsRpc = new WsProvider(WS_SERVER, 30 * 1000);

    viteClient = new Vitejs.client(wsRpc, function () {
        console.log('Already connected.');
    });

        
    genesisAccount = new Vitejs.wallet.account({
        privateKey: GENESIS_PRIVATEKEY,
        client: viteClient
    });

    // genesis account receive onroad blocks
    await receiveAllOnroadTx(viteClient, genesisAccount);

    return viteClient;
}

export function getVite () {
    return viteClient;
}

export function getGenesisAccount () {
    return genesisAccount;
}

export async function createAccount () {
    let genesisAccount = getGenesisAccount();

    let keyPair = Vitejs.utils.ed25519.keyPair();
    let account = new Vitejs.wallet.account({
        privateKey: keyPair.secretKey,
        client: viteClient
    });
            
    // send money to test accout
    await genesisAccount.sendTx({
        toAddress: account.address,
        tokenId: VITE_TOKEN_ID,
        amount: '1'
    });
    
    await receiveAllOnroadTx(viteClient, account);
    return account;
}

export async function createContract (account, contract, amount, params) {
    let latestSnapshotHash = await viteClient.ledger.getLatestSnapshotChainHash();


    let createContractBlock = await viteClient.buildinTxBlock.createContract({
        accountAddress: account.address,
        tokenId: VITE_TOKEN_ID,
        amount: amount.toString(),
        fee: '10000000000000000000',
        hexCode: contract.bytecodes,
        abi: JSON.stringify(contract.abi),
        snapshotHash: latestSnapshotHash,
        params: params
    }); 

    await account.sendRawTx(createContractBlock);
    return createContractBlock;
}

export async function sendContractTx (account,contractAddress, abi, amount, params) {
    let latestSnapshotHash = await viteClient.ledger.getLatestSnapshotChainHash();

    let callContractBlock = await viteClient.buildinTxBlock.callContract({
        accountAddress: account.address,
        tokenId: VITE_TOKEN_ID,
        amount: amount.toString(),
        jsonInterface: abi,
        snapshotHash: latestSnapshotHash,
        params: params,
        toAddress: contractAddress
    });

    await account.sendRawTx(callContractBlock);
    return callContractBlock;
}