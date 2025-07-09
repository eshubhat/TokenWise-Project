// backend/src/services/solanaService.ts
import {
  Connection,
  PublicKey,
  ParsedTransactionWithMeta,
  ParsedAccountData,
  GetProgramAccountsFilter,
  ConfirmedSignatureInfo,
  clusterApiUrl
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Wallet, Transaction } from "../types";
import { dbManager } from "../config/database";

// Rate limiting utility
class RateLimiter {
  private requests: number[] = [];
  private maxRequests: number;
  private timeWindow: number;

  constructor(maxRequests: number, timeWindowMs: number) {
    this.maxRequests = maxRequests;
    this.timeWindow = timeWindowMs;
  }

  async waitForAvailability(): Promise<void> {
    const now = Date.now();

    // Remove old requests outside the time window
    this.requests = this.requests.filter(
      (timestamp) => now - timestamp < this.timeWindow
    );

    if (this.requests.length >= this.maxRequests) {
      const oldestRequest = this.requests[0];
      const waitTime = this.timeWindow - (now - oldestRequest);

      if (waitTime > 0) {
        console.log(`Rate limit reached. Waiting ${waitTime}ms...`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        return this.waitForAvailability();
      }
    }

    this.requests.push(now);
  }
}

// Retry utility with exponential backoff
class RetryHelper {
  static async withRetry<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    baseDelay: number = 1000
  ): Promise<T> {
    let lastError: Error;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error: any) {
        lastError = error;

        if (attempt === maxRetries) {
          throw error;
        }

        // Check if it's a rate limit error
        if (
          error.message?.includes("429") ||
          error.message?.includes("Too Many Requests")
        ) {
          const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
          console.log(
            `Rate limit hit, retrying in ${delay}ms... (attempt ${
              attempt + 1
            }/${maxRetries + 1})`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          // For non-rate-limit errors, throw immediately
          throw error;
        }
      }
    }

    throw lastError!;
  }
}

export class SolanaService {
  private connection: Connection;
  private subscriptions: Map<string, { id: number; connection: Connection }> =
    new Map();
  private tokenMint: PublicKey;
  private rateLimiter: RateLimiter;
  private connectionPool: Connection[] = [];
  private topHoldersCache: Wallet[] = [];
  private lastTopHolderFetch = 0;

  constructor(rpcUrl: string, tokenMint: string) {
    this.connection = new Connection(rpcUrl, "confirmed");
    this.tokenMint = new PublicKey(tokenMint);
    this.rateLimiter = new RateLimiter(8, 1000); // allow 3 per second
    this.initializeConnectionPool(rpcUrl);
  }

  private initializeConnectionPool(rpcUrl: string): void {
    // Create a small pool of connections to distribute load
    for (let i = 0; i < 3; i++) {
      this.connectionPool.push(
        new Connection(rpcUrl, {
          commitment: "confirmed",
          confirmTransactionInitialTimeout: 60000,
        })
      );
    }
  }

  private getConnection(): Connection {
    // Round-robin connection selection
    const index = Math.floor(Math.random() * this.connectionPool.length);
    return this.connectionPool[index] || this.connection;
  }

  async getTopTokenHolders(limit: number = 60): Promise<Wallet[]> {
    const now = Date.now();
    if (this.topHoldersCache.length && now - this.lastTopHolderFetch < 30000) {
      return this.topHoldersCache.slice(0, limit);
    }

    const myHeaders = new Headers();
    myHeaders.append("Content-Type", "application/json");
    myHeaders.append(
      "Authorization",
      `Bearer ory_at_pu7PxymVtGdnj6kgKoO80ELrfcWlm15eym2uIQk1sz0.nNjc1MSFPShJ9DI0nJUU4K9TQAxbQ_QlSLvPHv3XEE4`
    );

    const raw = JSON.stringify({
      query:
        'query MyQuery {\n  Solana(dataset: realtime, network: solana, aggregates: yes) {\n    BalanceUpdates(\n      limit: { count: 60 }\n      orderBy: {descendingByField: "BalanceUpdate_Holding_maximum"}\n      where: {BalanceUpdate: {Currency: {MintAddress: {is: "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump"}}}, Transaction: {Result: {Success: true}}}\n    ) {\n      BalanceUpdate {\n        Currency {\n          Name\n          MintAddress\n          Symbol\n        }\n        Account {\n          Address\n        }\n        Holding: PostBalance(maximum: Block_Slot, selectWhere: {gt: "0"})\n      }\n    }\n  }\n}\n',
      variables: "{}",
    });

    // const requestOptions = {
    //    method: "POST",
    //    headers: myHeaders,
    //    body: raw,
    //    redirect: "follow"
    // };

    const response = await fetch("https://streaming.bitquery.io/eap", {
      method: "POST",
      headers: myHeaders,
      body: raw,
      redirect: "follow",
    });

    const result = await response.json();
    console.log("result: ", result?.data?.Solana?.BalanceUpdates?.length)
    const data = result?.data?.Solana?.BalanceUpdates || [];

    const wallets: Wallet[] = data.map((entry: any) => {
      const address = entry.BalanceUpdate.Account.Address;
      const tokenBalance = parseFloat(entry.BalanceUpdate.Holding || "0");

      return {
        address,
        tokenBalance,
        solBalance: 0, // optional enhancement: fetch with getMultipleAccountsInfo
        firstSeen: new Date(),
        lastActivity: new Date(),
        transactionCount: 0,
        totalVolume: 0,
      };
    });

    wallets.forEach((w) => dbManager.insertWallet(w));

    this.topHoldersCache = wallets;
    this.lastTopHolderFetch = now;

    return wallets.slice(0,60);
  }

  async subscribeToWalletTransactions(
    walletAddresses: string[]
  ): Promise<void> {
    console.log(`Subscribing to ${walletAddresses.length} wallets`);

    // Process subscriptions in smaller batches to avoid rate limits
    const batchSize = 5;
    for (let i = 0; i < walletAddresses.length; i += batchSize) {
      const batch = walletAddresses.slice(i, i + batchSize);

      for (const address of batch) {
        try {
          await this.rateLimiter.waitForAvailability();

          const publicKey = new PublicKey(address);
          const connection = this.getConnection();
          const subscriptionId = connection.onAccountChange(
            publicKey,
            async (accountInfo, context) => {
              console.log(`Account change detected for ${address}`);
              await this.handleAccountChange(address, accountInfo, context);
            },
            "confirmed"
          );

          this.subscriptions.set(address, { id: subscriptionId, connection });
        } catch (error) {
          console.error(`Error subscribing to wallet ${address}:`, error);
        }
      }

      // Add delay between batches
      if (i + batchSize < walletAddresses.length) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }

  private async handleAccountChange(
    walletAddress: string,
    accountInfo: any,
    context: any
  ): Promise<void> {
    try {
      await this.rateLimiter.waitForAvailability();

      // Get recent transactions for this wallet
      const signatures = await RetryHelper.withRetry(
        async () => {
          return await this.getConnection().getSignaturesForAddress(
            new PublicKey(walletAddress),
            { limit: 5 }
          );
        },
        3,
        1000
      );

      for (const signatureInfo of signatures) {
        await this.processTransaction(signatureInfo, walletAddress);
      }
    } catch (error) {
      console.error(
        `Error handling account change for ${walletAddress}:`,
        error
      );
    }
  }

  private async processTransaction(
    signatureInfo: ConfirmedSignatureInfo,
    walletAddress: string
  ): Promise<void> {
    try {
      await this.rateLimiter.waitForAvailability();

      const transaction = await RetryHelper.withRetry(
        async () => {
          return await this.getConnection().getParsedTransaction(
            signatureInfo.signature,
            { commitment: "confirmed", maxSupportedTransactionVersion: 0 }
          );
        },
        3,
        1000
      );

      if (!transaction) return;

      const analysis = await this.analyzeTransaction(
        transaction,
        walletAddress
      );
      if (analysis) {
        await dbManager.insertTransaction(analysis);
        console.log(
          `Processed transaction: ${analysis.type} ${analysis.amount} tokens via ${analysis.protocol}`
        );
      }
    } catch (error) {
      console.error(
        `Error processing transaction ${signatureInfo.signature}:`,
        error
      );
    }
  }

  private async analyzeTransaction(
    transaction: ParsedTransactionWithMeta,
    walletAddress: string
  ): Promise<Transaction | null> {
    try {
      if (!transaction.meta || !transaction.transaction) return null;

      const accountKeys = transaction.transaction.message.accountKeys;
      const preBalances = transaction.meta.preTokenBalances || [];
      const postBalances = transaction.meta.postTokenBalances || [];

      // Detect protocol
      const protocol = this.detectProtocol(
        accountKeys.map((key) => key.pubkey.toString())
      );

      // Calculate token balance change
      const tokenBalanceChange = this.calculateTokenBalanceChange(
        preBalances,
        postBalances,
        walletAddress
      );

      if (tokenBalanceChange === 0) return null;

      const transactionData: Transaction = {
        signature: transaction.transaction.signatures[0],
        timestamp: new Date(transaction.blockTime! * 1000),
        walletAddress,
        type: tokenBalanceChange > 0 ? "buy" : "sell",
        amount: Math.abs(tokenBalanceChange),
        protocol,
        priceImpact: 0, // Would need price oracle data
        fee: transaction.meta.fee / 1e9,
        tokenPrice: 0, // Would need price oracle data
      };

      return transactionData;
    } catch (error) {
      console.error("Error analyzing transaction:", error);
      return null;
    }
  }

  private detectProtocol(
    accountKeys: string[]
  ): "jupiter" | "raydium" | "orca" | "unknown" {
    const protocols = {
      jupiter: [
        "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB",
        "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
      ],
      raydium: [
        "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
        "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
      ],
      orca: [
        "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP",
        "DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1",
      ],
    };

    for (const [protocol, signatures] of Object.entries(protocols)) {
      if (accountKeys.some((key) => signatures.includes(key))) {
        return protocol as "jupiter" | "raydium" | "orca";
      }
    }

    return "unknown";
  }

  private calculateTokenBalanceChange(
    preBalances: any[],
    postBalances: any[],
    walletAddress: string
  ): number {
    const findBalance = (balances: any[], address: string) => {
      const balance = balances.find(
        (b) => b.owner === address && b.mint === this.tokenMint.toString()
      );
      return balance ? balance.uiTokenAmount.uiAmount : 0;
    };

    const preBalance = findBalance(preBalances, walletAddress);
    const postBalance = findBalance(postBalances, walletAddress);

    return postBalance - preBalance;
  }

  async getWalletTransactionHistory(
    walletAddress: string,
    limit: number = 50
  ): Promise<Transaction[]> {
    try {
      await this.rateLimiter.waitForAvailability();

      const signatures = await RetryHelper.withRetry(
        async () => {
          return await this.getConnection().getSignaturesForAddress(
            new PublicKey(walletAddress),
            { limit }
          );
        },
        3,
        1000
      );

      const transactions: Transaction[] = [];

      for (const signatureInfo of signatures) {
        await this.rateLimiter.waitForAvailability();

        const transaction = await RetryHelper.withRetry(
          async () => {
            return await this.getConnection().getParsedTransaction(
              signatureInfo.signature,
              { commitment: "confirmed", maxSupportedTransactionVersion: 0 }
            );
          },
          3,
          1000
        );

        if (transaction) {
          const analysis = await this.analyzeTransaction(
            transaction,
            walletAddress
          );
          if (analysis) {
            transactions.push(analysis);
          }
        }
      }

      return transactions;
    } catch (error) {
      console.error(
        `Error fetching transaction history for ${walletAddress}:`,
        error
      );
      return [];
    }
  }

  async unsubscribeAll(): Promise<void> {
    for (const [address, { id, connection }] of this.subscriptions.entries()) {
      try {
        await connection.removeAccountChangeListener(id);
        console.log(`Unsubscribed from ${address}`);
      } catch (err) {
        console.warn(`Could not unsubscribe from ${address}:`, err);
      }
    }
    this.subscriptions.clear();
  }

  // async refreshTokenHolders(): Promise<Wallet[]> {
  //   console.log("Refreshing token holders...");
  //   return await this.getTopTokenHolders(60);
  // }

  async getConnectionStatus(): Promise<{
    rpcConnected: boolean;
    activeSubscriptions: number;
    rateLimitInfo: { requestsInWindow: number; maxRequests: number };
  }> {
    try {
      await this.rateLimiter.waitForAvailability();
      const slot = await this.getConnection().getSlot();
      const rpcConnected = slot > 0;

      return {
        rpcConnected,
        activeSubscriptions: this.subscriptions.size,
        rateLimitInfo: {
          requestsInWindow: this.rateLimiter["requests"].length,
          maxRequests: this.rateLimiter["maxRequests"],
        },
      };
    } catch (error) {
      return {
        rpcConnected: false,
        activeSubscriptions: this.subscriptions.size,
        rateLimitInfo: {
          requestsInWindow: 0,
          maxRequests: 0,
        },
      };
    }
  }
}

// Alternative RPC URLs for fallback
const RPC_URLS = [
  "https://mainnet.helius-rpc.com/?api-key=2a904ac8-a433-4c02-890c-41cd68f6d54d",
];

// Configuration with fallback
const RPC_URL = RPC_URLS[0]; // Primary Alchemy RPC
const TOKEN_MINT = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";

export const solanaService = new SolanaService(RPC_URL, TOKEN_MINT);

const HELIUS_API_KEY = "2a904ac8-a433-4c02-890c-41cd68f6d54d";
const HELIUS_API_URL = `https://api.helius.xyz/v0/addresses`;

export async function fetchRecentTransactions(tokenAddress: string): Promise<Transaction[]> {
  const url = `${HELIUS_API_URL}/${tokenAddress}/transactions?api-key=${HELIUS_API_KEY}&limit=50`;

  const res = await fetch(url);
  if (!res.ok) {
    console.error("Helius API Error:", res.statusText);
    return [];
  }

  const data = await res.json();

  const transactions: Transaction[] = data.map((tx: any) => {
    const signature = tx.signature;
    const timestamp = new Date(tx.timestamp * 1000);
    const protocol = tx.source?.toLowerCase() || "unknown";
    const fee = tx.fee || 0;

    const tokenTransfer = tx.tokenTransfers?.[0];
    const nativeTransfer = tx.nativeTransfers?.[0];

    // Use the account involved in the transfer as walletAddress
    const walletAddress = tokenTransfer?.fromUserAccount || nativeTransfer?.fromUserAccount || "unknown";

    const amount = tokenTransfer?.amount || nativeTransfer?.amount || 0;

    // Basic logic to determine buy/sell direction
    const type = tokenTransfer?.fromUserAccount === tokenAddress ? 'sell' : 'buy';

    return {
      signature,
      timestamp,
      walletAddress,
      type,
      amount,
      protocol,
      priceImpact: 0, // Not provided by Helius directly
      fee,
    };
  });

  return transactions;
}

