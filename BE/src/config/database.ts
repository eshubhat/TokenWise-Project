// backend/src/config/database.ts
import sqlite3 from "sqlite3";
import { Database, open } from "sqlite";
import path from "path";

export interface Wallet {
  address: string;
  tokenBalance: number;
  solBalance: number;
  firstSeen: Date;
  lastActivity: Date;
  transactionCount: number;
  totalVolume: number;
}

export interface Transaction {
  signature: string;
  timestamp: Date;
  walletAddress: string;
  type: "buy" | "sell";
  amount: number;
  protocol: "jupiter" | "raydium" | "orca" | "unknown";
  priceImpact: number;
  fee: number;
  tokenPrice?: number;
}

export interface DashboardMetrics {
  totalBuys: number;
  totalSells: number;
  buyVolume: number;
  sellVolume: number;
  activeWallets: number;
  protocolBreakdown: Record<string, number>;
  topWallets: Wallet[];
}

export class DatabaseManager {
  private db: Database | null = null;
  private dbPath: string;

  constructor(dbPath?: string) {
    // Use provided path or default to data directory
    this.dbPath = dbPath || path.join(process.cwd(), "data", "tokenwise.db");

    // Ensure data directory exists
    const dataDir = path.dirname(this.dbPath);
    if (!require("fs").existsSync(dataDir)) {
      require("fs").mkdirSync(dataDir, { recursive: true });
    }
  }

  async initialize(): Promise<void> {
    try {
      console.log(`Initializing database at: ${this.dbPath}`);

      this.db = await open({
        filename: this.dbPath,
        driver: sqlite3.Database,
      });

      await this.db.exec("PRAGMA foreign_keys = ON");
      await this.db.exec("PRAGMA journal_mode = WAL");
      await this.createTables();

      console.log("Database initialized successfully");
    } catch (error) {
      console.error("Database initialization failed:", error);
      throw error;
    }
  }

  private async createTables(): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    // Wallets table with comprehensive tracking
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS wallets (
        address TEXT PRIMARY KEY,
        token_balance REAL DEFAULT 0,
        sol_balance REAL DEFAULT 0,
        first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
        transaction_count INTEGER DEFAULT 0,
        total_volume REAL DEFAULT 0,
        total_buy_volume REAL DEFAULT 0,
        total_sell_volume REAL DEFAULT 0,
        avg_transaction_size REAL DEFAULT 0,
        largest_transaction REAL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Transactions table with enhanced fields
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS transactions (
        signature TEXT PRIMARY KEY,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        wallet_address TEXT NOT NULL,
        type TEXT CHECK(type IN ('buy', 'sell')) NOT NULL,
        amount REAL NOT NULL,
        protocol TEXT NOT NULL,
        price_impact REAL DEFAULT 0,
        fee REAL DEFAULT 0,
        token_price REAL DEFAULT 0,
        sol_amount REAL DEFAULT 0,
        block_slot INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (wallet_address) REFERENCES wallets (address)
      )
    `);

    // System metrics table for tracking overall system health
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS system_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metric_name TEXT NOT NULL,
        metric_value REAL NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create performance indexes
    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_transactions_wallet ON transactions(wallet_address);
      CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
      CREATE INDEX IF NOT EXISTS idx_transactions_protocol ON transactions(protocol);
      CREATE INDEX IF NOT EXISTS idx_transactions_amount ON transactions(amount DESC);
      CREATE INDEX IF NOT EXISTS idx_wallets_balance ON wallets(token_balance DESC);
      CREATE INDEX IF NOT EXISTS idx_wallets_activity ON wallets(last_activity DESC);
      CREATE INDEX IF NOT EXISTS idx_wallets_volume ON wallets(total_volume DESC);
      CREATE INDEX IF NOT EXISTS idx_system_metrics_name ON system_metrics(metric_name);
      CREATE INDEX IF NOT EXISTS idx_system_metrics_timestamp ON system_metrics(timestamp DESC);
    `);

    await this.db.exec(`
    CREATE TABLE IF NOT EXISTS dex_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_address TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      open REAL,
      high REAL,
      low REAL,
      close REAL,
      volume REAL,
      UNIQUE(token_address, timestamp)
    );

    CREATE TABLE IF NOT EXISTS market_trends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

    console.log("Database tables and indexes created successfully");
  }

  async insertWallet(wallet: Wallet): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    try {
      await this.db.run(
        `
        INSERT OR REPLACE INTO wallets 
        (address, token_balance, sol_balance, first_seen, last_activity, 
         transaction_count, total_volume, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `,
        [
          wallet.address,
          wallet.tokenBalance,
          wallet.solBalance,
          wallet.firstSeen.toISOString(),
          wallet.lastActivity.toISOString(),
          wallet.transactionCount,
          wallet.totalVolume,
        ]
      );
    } catch (error) {
      console.error("Error inserting wallet:", error);
      throw error;
    }
  }

  async insertTransaction(transaction: Transaction): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    try {
      await this.db.run(
        `
        INSERT OR REPLACE INTO transactions 
        (signature, timestamp, wallet_address, type, amount, protocol, 
         price_impact, fee, token_price, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `,
        [
          transaction.signature,
          transaction.timestamp.toISOString(),
          transaction.walletAddress,
          transaction.type,
          transaction.amount,
          transaction.protocol,
          transaction.priceImpact,
          transaction.fee,
          transaction.tokenPrice,
        ]
      );

      // Update wallet statistics
      await this.updateWalletStats(transaction.walletAddress);
    } catch (error) {
      console.error("Error inserting transaction:", error);
      throw error;
    }
  }

  private async updateWalletStats(walletAddress: string): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    try {
      await this.db.run(
        `
        UPDATE wallets 
        SET 
          transaction_count = (
            SELECT COUNT(*) FROM transactions WHERE wallet_address = ?
          ),
          total_volume = (
            SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE wallet_address = ?
          ),
          total_buy_volume = (
            SELECT COALESCE(SUM(amount), 0) FROM transactions 
            WHERE wallet_address = ? AND type = 'buy'
          ),
          total_sell_volume = (
            SELECT COALESCE(SUM(amount), 0) FROM transactions 
            WHERE wallet_address = ? AND type = 'sell'
          ),
          avg_transaction_size = (
            SELECT COALESCE(AVG(amount), 0) FROM transactions WHERE wallet_address = ?
          ),
          largest_transaction = (
            SELECT COALESCE(MAX(amount), 0) FROM transactions WHERE wallet_address = ?
          ),
          last_activity = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE address = ?
      `,
        [
          walletAddress,
          walletAddress,
          walletAddress,
          walletAddress,
          walletAddress,
          walletAddress,
          walletAddress,
        ]
      );
    } catch (error) {
      console.error("Error updating wallet stats:", error);
      throw error;
    }
  }

  // Insert a DEX candle row
  async insertDexTrade(
    tokenAddress: string,
    data: {
      timestamp: string;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }
  ) {
    if (!this.db) throw new Error("Database not initialized");
    const { timestamp, open, high, low, close, volume } = data;

    await this.db.run(
      `
    INSERT OR IGNORE INTO dex_trades 
    (token_address, timestamp, open, high, low, close, volume) 
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
      [tokenAddress, timestamp, open, high, low, close, volume]
    );
  }

  // Fetch cached dex trades
  async getCachedDexTrades(tokenAddress: string, sinceHours: number = 48) {
    if (!this.db) throw new Error("Database not initialized");

    const rows = await this.db.all(
      `
    SELECT * FROM dex_trades 
    WHERE token_address = ? AND timestamp >= datetime('now', ?)
    ORDER BY timestamp ASC
  `,
      [tokenAddress, `-${sinceHours} hours`]
    );

    return rows;
  }

  // Insert market trends
  async insertMarketTrends(type: string, data: any) {
    if (!this.db) throw new Error("Database not initialized");
    await this.db.run(
      `
    INSERT INTO market_trends (type, data, fetched_at) VALUES (?, ?, CURRENT_TIMESTAMP)
  `,
      [type, JSON.stringify(data)]
    );
  }

  // Fetch cached market trends
  async getCachedMarketTrends(type: string, maxAgeMinutes = 60) {
    if (!this.db) throw new Error("Database not initialized");
    return await this.db.get(
      `
    SELECT * FROM market_trends 
    WHERE type = ? AND fetched_at >= datetime('now', ?)
    ORDER BY fetched_at DESC LIMIT 1
  `,
      [type, `-${maxAgeMinutes} minutes`]
    );
  }

  async getTopWallets(limit: number = 60): Promise<Wallet[]> {
    if (!this.db) throw new Error("Database not initialized");

    try {
      const rows = await this.db.all(
        `
        SELECT * FROM wallets 
        ORDER BY token_balance DESC 
        LIMIT ?
      `,
        [limit]
      );

      return rows.map((row: any) => ({
        address: row.address,
        tokenBalance: row.token_balance,
        solBalance: row.sol_balance,
        firstSeen: new Date(row.first_seen),
        lastActivity: new Date(row.last_activity),
        transactionCount: row.transaction_count,
        totalVolume: row.total_volume,
      }));
    } catch (error) {
      console.error("Error fetching top wallets:", error);
      throw error;
    }
  }

  async getTransactions(filters: {
    walletAddress?: string;
    type?: "buy" | "sell";
    protocol?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  }): Promise<Transaction[]> {
    if (!this.db) throw new Error("Database not initialized");

    try {
      let query = "SELECT * FROM transactions WHERE 1=1";
      const params: any[] = [];

      if (filters.walletAddress) {
        query += " AND wallet_address = ?";
        params.push(filters.walletAddress);
      }

      if (filters.type) {
        query += " AND type = ?";
        params.push(filters.type);
      }

      if (filters.protocol) {
        query += " AND protocol = ?";
        params.push(filters.protocol);
      }

      if (filters.startDate) {
        query += " AND timestamp >= ?";
        params.push(filters.startDate.toISOString());
      }

      if (filters.endDate) {
        query += " AND timestamp <= ?";
        params.push(filters.endDate.toISOString());
      }

      query += " ORDER BY timestamp DESC";

      if (filters.limit) {
        query += " LIMIT ?";
        params.push(filters.limit);
      }

      if (filters.offset) {
        query += " OFFSET ?";
        params.push(filters.offset);
      }

      const rows = await this.db.all(query, params);

      return rows.map((row: any) => ({
        signature: row.signature,
        timestamp: new Date(row.timestamp),
        walletAddress: row.wallet_address,
        type: row.type,
        amount: row.amount,
        protocol: row.protocol,
        priceImpact: row.price_impact,
        fee: row.fee,
        tokenPrice: row.token_price,
      }));
    } catch (error) {
      console.error("Error fetching transactions:", error);
      throw error;
    }
  }

  async getDashboardMetrics(timeRange?: {
    start: Date;
    end: Date;
  }): Promise<DashboardMetrics> {
    if (!this.db) throw new Error("Database not initialized");

    try {
      let timeFilter = "";
      const params: any[] = [];

      if (timeRange) {
        timeFilter = "WHERE timestamp >= ? AND timestamp <= ?";
        params.push(timeRange.start.toISOString(), timeRange.end.toISOString());
      }

      // Get buy/sell metrics
      const metricsQuery = `
        SELECT 
          type,
          COUNT(*) as count,
          SUM(amount) as volume,
          AVG(amount) as avg_amount
        FROM transactions 
        ${timeFilter}
        GROUP BY type
      `;

      interface MetricsRow {
        type: "buy" | "sell";
        count: number;
        volume: number;
        avg_amount: number;
      }

      const metricsRows = (await this.db.all(
        metricsQuery,
        params
      )) as MetricsRow[];

      // Get protocol breakdown
      const protocolQuery = `
        SELECT 
          protocol,
          COUNT(*) as count,
          SUM(amount) as volume
        FROM transactions 
        ${timeFilter}
        GROUP BY protocol
      `;

      interface ProtocolRow {
        protocol: string;
        count: number;
        volume: number;
      }

      const protocolRows = (await this.db.all(
        protocolQuery,
        params
      )) as ProtocolRow[];

      // Get active wallets
      const activeWalletsQuery = `
        SELECT COUNT(DISTINCT wallet_address) as count
        FROM transactions 
        ${timeFilter}
      `;

      interface CountRow {
        count: number;
      }

      const activeWalletsRow = (await this.db.get(
        activeWalletsQuery,
        params
      )) as CountRow;

      // Get top wallets
      const topWallets = await this.getTopWallets(10);

      const metrics: DashboardMetrics = {
        totalBuys: 0,
        totalSells: 0,
        buyVolume: 0,
        sellVolume: 0,
        activeWallets: activeWalletsRow?.count || 0,
        protocolBreakdown: {},
        topWallets,
      };

      // Process buy/sell metrics
      metricsRows.forEach((row) => {
        if (row.type === "buy") {
          metrics.totalBuys = row.count;
          metrics.buyVolume = row.volume || 0;
        } else if (row.type === "sell") {
          metrics.totalSells = row.count;
          metrics.sellVolume = row.volume || 0;
        }
      });

      // Process protocol breakdown
      protocolRows.forEach((row) => {
        metrics.protocolBreakdown[row.protocol] = row.count;
      });

      return metrics;
    } catch (error) {
      console.error("Error fetching dashboard metrics:", error);
      throw error;
    }
  }

  async getWalletStats(walletAddress: string): Promise<any> {
    if (!this.db) throw new Error("Database not initialized");

    try {
      const walletQuery = `
        SELECT 
          w.*,
          COUNT(t.signature) as recent_transactions,
          AVG(t.amount) as avg_transaction_amount,
          MAX(t.amount) as max_transaction_amount,
          MIN(t.timestamp) as first_transaction,
          MAX(t.timestamp) as last_transaction
        FROM wallets w
        LEFT JOIN transactions t ON w.address = t.wallet_address
        WHERE w.address = ?
        GROUP BY w.address
      `;

      interface WalletStatsRow {
        address: string;
        token_balance: number;
        sol_balance: number;
        first_seen: string;
        last_activity: string;
        transaction_count: number;
        total_volume: number;
        total_buy_volume: number;
        total_sell_volume: number;
        avg_transaction_size: number;
        largest_transaction: number;
        created_at: string;
        updated_at: string;
        recent_transactions: number;
        avg_transaction_amount: number;
        max_transaction_amount: number;
        first_transaction: string | null;
        last_transaction: string | null;
      }

      const walletRow = (await this.db.get(walletQuery, [
        walletAddress,
      ])) as WalletStatsRow;

      if (!walletRow) {
        return null;
      }

      const protocolUsageQuery = `
        SELECT protocol, COUNT(*) as count, SUM(amount) as volume
        FROM transactions 
        WHERE wallet_address = ?
        GROUP BY protocol
      `;

      interface ProtocolUsageRow {
        protocol: string;
        count: number;
        volume: number;
      }

      const protocolUsage = (await this.db.all(protocolUsageQuery, [
        walletAddress,
      ])) as ProtocolUsageRow[];

      const recentTransactionsQuery = `
        SELECT * FROM transactions 
        WHERE wallet_address = ?
        ORDER BY timestamp DESC
        LIMIT 10
      `;

      const recentTransactions = await this.db.all(recentTransactionsQuery, [
        walletAddress,
      ]);

      return {
        wallet: {
          address: walletRow.address,
          tokenBalance: walletRow.token_balance,
          solBalance: walletRow.sol_balance,
          firstSeen: new Date(walletRow.first_seen),
          lastActivity: new Date(walletRow.last_activity),
          transactionCount: walletRow.transaction_count,
          totalVolume: walletRow.total_volume,
          totalBuyVolume: walletRow.total_buy_volume,
          totalSellVolume: walletRow.total_sell_volume,
          avgTransactionSize: walletRow.avg_transaction_size,
          largestTransaction: walletRow.largest_transaction,
        },
        stats: {
          recentTransactions: walletRow.recent_transactions,
          avgTransactionAmount: walletRow.avg_transaction_amount,
          maxTransactionAmount: walletRow.max_transaction_amount,
          firstTransaction: walletRow.first_transaction
            ? new Date(walletRow.first_transaction)
            : null,
          lastTransaction: walletRow.last_transaction
            ? new Date(walletRow.last_transaction)
            : null,
        },
        protocolUsage: protocolUsage.reduce((acc, row) => {
          acc[row.protocol] = {
            count: row.count,
            volume: row.volume,
          };
          return acc;
        }, {} as Record<string, { count: number; volume: number }>),
        recentTransactions: recentTransactions.map((row: any) => ({
          signature: row.signature,
          timestamp: new Date(row.timestamp),
          type: row.type,
          amount: row.amount,
          protocol: row.protocol,
          fee: row.fee,
        })),
      };
    } catch (error) {
      console.error("Error fetching wallet stats:", error);
      throw error;
    }
  }

  async recordSystemMetric(name: string, value: number): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    try {
      await this.db.run(
        `
        INSERT INTO system_metrics (metric_name, metric_value, timestamp)
        VALUES (?, ?, CURRENT_TIMESTAMP)
      `,
        [name, value]
      );
    } catch (error) {
      console.error("Error recording system metric:", error);
      throw error;
    }
  }

  async getSystemMetrics(
    metricName?: string,
    hours: number = 24
  ): Promise<any[]> {
    if (!this.db) throw new Error("Database not initialized");

    try {
      let query = `
        SELECT * FROM system_metrics 
        WHERE timestamp >= datetime('now', '-${hours} hours')
      `;
      const params: any[] = [];

      if (metricName) {
        query += " AND metric_name = ?";
        params.push(metricName);
      }

      query += " ORDER BY timestamp DESC";

      const rows = await this.db.all(query, params);
      return rows.map((row: any) => ({
        id: row.id,
        metricName: row.metric_name,
        metricValue: row.metric_value,
        timestamp: new Date(row.timestamp),
      }));
    } catch (error) {
      console.error("Error fetching system metrics:", error);
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    if (!this.db) return;

    try {
      // Clean up old system metrics (keep last 7 days)
      await this.db.run(`
        DELETE FROM system_metrics 
        WHERE timestamp < datetime('now', '-7 days')
      `);

      // Vacuum database to reclaim space
      await this.db.exec("VACUUM");

      console.log("Database cleanup completed");
    } catch (error) {
      console.error("Error during database cleanup:", error);
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
      console.log("Database connection closed");
    }
  }

  getDatabase(): Database {
    if (!this.db) throw new Error("Database not initialized");
    return this.db;
  }

  async healthCheck(): Promise<{
    status: string;
    tablesCount: number;
    lastTransaction?: Date;
  }> {
    if (!this.db) throw new Error("Database not initialized");

    try {
      // Check if database is responsive
      const result = await this.db.get("SELECT 1 as test");
      if (!result) throw new Error("Database not responsive");

      // Count tables
      const tables = await this.db.all(`
        SELECT name FROM sqlite_master WHERE type='table'
      `);

      // Get last transaction timestamp
      interface LastTxn {
        last_timestamp: string | null;
      }

      const lastTx = (await this.db.get(`
        SELECT MAX(timestamp) as last_timestamp FROM transactions
      `)) as LastTxn;

      return {
        status: "healthy",
        tablesCount: tables.length,
        lastTransaction: lastTx?.last_timestamp
          ? new Date(lastTx.last_timestamp)
          : undefined,
      };
    } catch (error) {
      console.error("Database health check failed:", error);
      return {
        status: "unhealthy",
        tablesCount: 0,
      };
    }
  }
}

// Singleton instance
export const dbManager = new DatabaseManager();

// Export for testing with custom path
export const createDatabaseManager = (dbPath: string) =>
  new DatabaseManager(dbPath);
