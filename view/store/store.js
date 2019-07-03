import Vue from 'vue';
import Vuex from 'vuex';
import dayjs from 'dayjs';
// deployInfo:
// var deployInfo = {
//     compileInfo: '',
//     selectedAccount: '',
//     selectedAccountAddress: '',
//     accounts: [], // [viteAccount]
//     contractList: [] // [contractList]
//     logs: []
// };

Vue.use(Vuex);

const store = new Vuex.Store({
    state: {
        deployInfoList: []
    },
    mutations: {
        init(state, { compileResult, initAccounts }) {
            let deployInfoList = [];

            for (let i = 0; i < compileResult.abiList.length; i++) {
                let compileInfo = {
                    abi: compileResult.abiList[i],
                    bytecodes: compileResult.bytecodesList[i],
                    contractName: compileResult.contractNameList[i],
                    offchainCode: compileResult.offchainCodesList[i]
                };

                let deployInfo = {
                    index: i,
                    compileInfo,

                    accounts: [initAccounts[i]],
                    addressMap: {},

                    selectedAccount: initAccounts[i],
                    selectedAccountAddress: initAccounts[i].address,
                    sendCreateBlocks: [],
                    logs: []
                };
                deployInfo.addressMap[initAccounts[i].address] = initAccounts[i];
                deployInfoList.push(deployInfo);
            }

            state.deployInfoList = deployInfoList;
        },

        addAccount(state, { index, account }) {
            let deployInfo = state.deployInfoList[index];

            deployInfo.accounts.push(account);
            deployInfo.addressMap[account.address] = account;
        },

        selectAccount(state, { index, address }) {
            let deployInfo = state.deployInfoList[index];
            let accounts = deployInfo.accounts;
            for (let account of accounts) {
                if (address === account.address) {
                    deployInfo.selectedAccountAddress = address;
                    deployInfo.selectedAccount = account;
                    break;
                }
            }
        },
        // deployInfo: this.deployInfo,
        // sendCreateBlock: createContractBlock
        deployed(state, { deployInfo, sendCreateBlock }) {
            //             contractAddress: contractBlock.toAddress,
            //             contractBlock,
            //             abi,
            //             contractName,
            //             offchainCode
            deployInfo.sendCreateBlocks.push(sendCreateBlock);
        },
        addLog(state, { deployInfo, log, type = 'info' }) {
            deployInfo.logs.push({
                createdTime: dayjs(),
                content: log,
                type
            });
        }
    }
});

export default store;
