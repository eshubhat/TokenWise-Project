"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.solanaService = exports.SolanaService = void 0;
// backend/src/services/solanaService.ts
const web3_js_1 = require("@solana/web3.js");
const spl_token_1 = require("@solana/spl-token");
const database_1 = require("../config/database");
class SolanaService {
    constructor(rpcUrl, wsUrl, tokenMint) {
        this.subscriptions = new Map();
        this.connection = new web3_js_1.Connection(rpcUrl, 'confirmed');
        this.wsConnection = new web3_js_1.Connection(wsUrl, 'confirmed');
        this.tokenMint = new web3_js_1.PublicKey(tokenMint);
    }
    async getTopTokenHolders(limit = 60) {
        try {
            console.log(`Fetching top ${limit} token holders for ${this.tokenMint.toString()}`);
            const filters = [
                {
                    dataSize: 165, // Token account data size
                },
                {
                    memcmp: {
                        offset: 0,
                        bytes: this.tokenMint.toString(),
                    },
                },
            ];
            const tokenAccounts = await this.connection.getParsedProgramAccounts(spl_token_1.TOKEN_PROGRAM_ID, {
                filters,
                commitment: 'confirmed',
            });
            console.log(`Found ${tokenAccounts.length} token accounts`);
            const wallets = [];
            for (const account of tokenAccounts) {
                const accountData = account.account.data;
                const parsed = accountData.parsed;
                if (parsed && parsed.info) {
                    const owner = parsed.info.owner;
                    const balance = parsed.info.tokenAmount.uiAmount || 0;
                    if (balance > 0) {
                        // Get SOL balance
                        const solBalance = await this.connection.getBalance(new web3_js_1.PublicKey(owner));
                        const wallet = {
                            address: owner,
                            tokenBalance: balance,
                            solBalance: solBalance / 1e9, // Convert lamports to SOL
                            firstSeen: new Date(),
                            lastActivity: new Date(),
                            transactionCount: 0,
                            totalVolume: 0
                        };
                        wallets.push(wallet);
                    }
                }
            }
            // Sort by token balance and take top holders
            const topWallets = wallets
                .sort((a, b) => b.tokenBalance - a.tokenBalance)
                .slice(0, limit);
            console.log(`Returning top ${topWallets.length} wallets`);
            // Store in database
            for (const wallet of topWallets) {
                await database_1.dbManager.insertWallet(wallet);
            }
            return topWallets;
        }
        catch (error) {
            console.error('Error fetching token holders:', error);
            throw error;
        }
    }
    async subscribeToWalletTransactions(walletAddresses) {
        console.log(`Subscribing to ${walletAddresses.length} wallets`);
        for (const address of walletAddresses) {
            try {
                const publicKey = new web3_js_1.PublicKey(address);
                // Subscribe to account changes
                const subscriptionId = this.wsConnection.onAccountChange(publicKey, async (accountInfo, context) => {
                    console.log(`Account change detected for ${address}`);
                    await this.handleAccountChange(address, accountInfo, context);
                }, 'confirmed');
                this.subscriptions.set(address, subscriptionId);
            }
            catch (error) {
                console.error(`Error subscribing to wallet ${address}:`, error);
            }
        }
    }
    async handleAccountChange(walletAddress, accountInfo, context) {
        try {
            // Get recent transactions for this wallet
            const signatures = await this.connection.getSignaturesForAddress(new web3_js_1.PublicKey(walletAddress), { limit: 5 });
            for (const signatureInfo of signatures) {
                await this.processTransaction(signatureInfo, walletAddress);
            }
        }
        catch (error) {
            console.error(`Error handling account change for ${walletAddress}:`, error);
        }
    }
    async processTransaction(signatureInfo, walletAddress) {
        try {
            const transaction = await this.connection.getParsedTransaction(signatureInfo.signature, { commitment: 'confirmed' });
            if (!transaction)
                return;
            const analysis = await this.analyzeTransaction(transaction, walletAddress);
            if (analysis) {
                await database_1.dbManager.insertTransaction(analysis);
                console.log(`Processed transaction: ${analysis.type} ${analysis.amount} tokens via ${analysis.protocol}`);
            }
        }
        catch (error) {
            console.error(`Error processing transaction ${signatureInfo.signature}:`, error);
        }
    }
    async analyzeTransaction(transaction, walletAddress) {
        try {
            if (!transaction.meta || !transaction.transaction)
                return null;
            const accountKeys = transaction.transaction.message.accountKeys;
            const preBalances = transaction.meta.preTokenBalances || [];
            const postBalances = transaction.meta.postTokenBalances || [];
            // Detect protocol
            const protocol = this.detectProtocol(accountKeys.map(key => key.pubkey.toString()));
            // Calculate token balance change
            const tokenBalanceChange = this.calculateTokenBalanceChange(preBalances, postBalances, walletAddress);
            if (tokenBalanceChange === 0)
                return null;
            const transactionData = {
                signature: transaction.transaction.signatures[0],
                timestamp: new Date(transaction.blockTime * 1000),
                walletAddress,
                type: tokenBalanceChange > 0 ? 'buy' : 'sell',
                amount: Math.abs(tokenBalanceChange),
                protocol,
                priceImpact: 0, // Would need price oracle data
                fee: transaction.meta.fee / 1e9,
                tokenPrice: 0 // Would need price oracle data
            };
            return transactionData;
        }
        catch (error) {
            console.error('Error analyzing transaction:', error);
            return null;
        }
    }
    detectProtocol(accountKeys) {
        const protocols = {
            jupiter: [
                'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',
                'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
            ],
            raydium: [
                '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
                '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1'
            ],
            orca: [
                '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP',
                'DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1'
            ]
        };
        for (const [protocol, signatures] of Object.entries(protocols)) {
            if (accountKeys.some(key => signatures.includes(key))) {
                return protocol;
            }
        }
        return 'unknown';
    }
    calculateTokenBalanceChange(preBalances, postBalances, walletAddress) {
        const findBalance = (balances, address) => {
            const balance = balances.find(b => b.owner === address && b.mint === this.tokenMint.toString());
            return balance ? balance.uiTokenAmount.uiAmount : 0;
        };
        const preBalance = findBalance(preBalances, walletAddress);
        const postBalance = findBalance(postBalances, walletAddress);
        return postBalance - preBalance;
    }
    async getWalletTransactionHistory(walletAddress, limit = 50) {
        try {
            const signatures = await this.connection.getSignaturesForAddress(new web3_js_1.PublicKey(walletAddress), { limit });
            const transactions = [];
            for (const signatureInfo of signatures) {
                const transaction = await this.connection.getParsedTransaction(signatureInfo.signature, { commitment: 'confirmed' });
                if (transaction) {
                    const analysis = await this.analyzeTransaction(transaction, walletAddress);
                    if (analysis) {
                        transactions.push(analysis);
                    }
                }
            }
            return transactions;
        }
        catch (error) {
            console.error(`Error fetching transaction history for ${walletAddress}:`, error);
            return [];
        }
    }
    async unsubscribeAll() {
        for (const [address, subscriptionId] of this.subscriptions) {
            try {
                await this.wsConnection.removeAccountChangeListener(subscriptionId);
                console.log(`Unsubscribed from ${address}`);
            }
            catch (error) {
                console.error(`Error unsubscribing from ${address}:`, error);
            }
        }
        this.subscriptions.clear();
    }
    async refreshTokenHolders() {
        console.log('Refreshing token holders...');
        return await this.getTopTokenHolders(60);
    }
    async getConnectionStatus() {
        try {
            const slot = await this.connection.getSlot();
            const rpcConnected = slot > 0;
            return {
                rpcConnected,
                wsConnected: true, // WebSocket connection status is harder to check
                activeSubscriptions: this.subscriptions.size
            };
        }
        catch (error) {
            return {
                rpcConnected: false,
                wsConnected: false,
                activeSubscriptions: this.subscriptions.size
            };
        }
    }
}
exports.SolanaService = SolanaService;
// Configuration
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const WS_URL = process.env.SOLANA_WS_URL || 'wss://api.mainnet-beta.solana.com';
const TOKEN_MINT = process.env.TOKEN_MINT || '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump';
exports.solanaService = new SolanaService(RPC_URL, WS_URL, TOKEN_MINT);
