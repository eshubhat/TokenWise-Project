// backend/src/types/index.ts
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
  type: 'buy' | 'sell';
  amount: number;
  protocol: 'jupiter' | 'raydium' | 'orca' | 'unknown';
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

// backend/src/config/database.ts
import sqlite3 from 'sqlite3';
import { Database, open } from 'sqlite';

export class DatabaseManager {
  private db: Database | null = null;

  async initialize(): Promise<void> {
    this.db = await open({
      filename: './tokenwise.db',
      driver: sqlite3.Database
    });

    await this.createTables();
  }

  private async createTables(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    // Wallets table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS wallets (
        address TEXT PRIMARY KEY,
        token_balance REAL DEFAULT 0,
        sol_balance REAL DEFAULT 0,
        first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
        transaction_count INTEGER DEFAULT 0,
        total_volume REAL DEFAULT 0
      )
    `);

    // Transactions table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS transactions (
        signature TEXT PRIMARY KEY,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        wallet_address TEXT,
        type TEXT CHECK(type IN ('buy', 'sell')),
        amount REAL,
        protocol TEXT,
        price_impact REAL,
        fee REAL,
        token_price REAL,
        FOREIGN KEY (wallet_address) REFERENCES wallets (address)
      )
    `);

    // Create indexes for better performance
    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions(timestamp);
      CREATE INDEX IF NOT EXISTS idx_transactions_wallet ON transactions(wallet_address);
      CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
    `);
  }

  async insertWallet(wallet: Wallet): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    await this.db.run(`
      INSERT OR REPLACE INTO wallets 
      (address, token_balance, sol_balance, first_seen, last_activity, transaction_count, total_volume)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      wallet.address,
      wallet.tokenBalance,
      wallet.solBalance,
      wallet.firstSeen,
      wallet.lastActivity,
      wallet.transactionCount,
      wallet.totalVolume
    ]);
  }

  async insertTransaction(transaction: Transaction): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    await this.db.run(`
      INSERT OR REPLACE INTO transactions 
      (signature, timestamp, wallet_address, type, amount, protocol, price_impact, fee, token_price)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      transaction.signature,
      transaction.timestamp,
      transaction.walletAddress,
      transaction.type,
      transaction.amount,
      transaction.protocol,
      transaction.priceImpact,
      transaction.fee,
      transaction.tokenPrice
    ]);

    // Update wallet stats
    await this.updateWalletStats(transaction.walletAddress);
  }

  private async updateWalletStats(walletAddress: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    await this.db.run(`
      UPDATE wallets 
      SET 
        transaction_count = (
          SELECT COUNT(*) FROM transactions WHERE wallet_address = ?
        ),
        total_volume = (
          SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE wallet_address = ?
        ),
        last_activity = CURRENT_TIMESTAMP
      WHERE address = ?
    `, [walletAddress, walletAddress, walletAddress]);
  }

  async getTopWallets(limit: number = 60): Promise<Wallet[]> {
    if (!this.db) throw new Error('Database not initialized');

    const rows = await this.db.all(`
      SELECT * FROM wallets 
      ORDER BY token_balance DESC 
      LIMIT ?
    `, [limit]);

    return rows.map(row => ({
      address: row.address,
      tokenBalance: row.token_balance,
      solBalance: row.sol_balance,
      firstSeen: new Date(row.first_seen),
      lastActivity: new Date(row.last_activity),
      transactionCount: row.transaction_count,
      totalVolume: row.total_volume
    }));
  }

  async getTransactions(filters: {
    walletAddress?: string;
    type?: 'buy' | 'sell';
    startDate?: Date;
    endDate?: Date;
    limit?: number;
  }): Promise<Transaction[]> {
    if (!this.db) throw new Error('Database not initialized');

    let query = 'SELECT * FROM transactions WHERE 1=1';
    const params: any[] = [];

    if (filters.walletAddress) {
      query += ' AND wallet_address = ?';
      params.push(filters.walletAddress);
    }

    if (filters.type) {
      query += ' AND type = ?';
      params.push(filters.type);
    }

    if (filters.startDate) {
      query += ' AND timestamp >= ?';
      params.push(filters.startDate.toISOString());
    }

    if (filters.endDate) {
      query += ' AND timestamp <= ?';
      params.push(filters.endDate.toISOString());
    }

    query += ' ORDER BY timestamp DESC';

    if (filters.limit) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }

    const rows = await this.db.all(query, params);

    return rows.map(row => ({
      signature: row.signature,
      timestamp: new Date(row.timestamp),
      walletAddress: row.wallet_address,
      type: row.type,
      amount: row.amount,
      protocol: row.protocol,
      priceImpact: row.price_impact,
      fee: row.fee,
      tokenPrice: row.token_price
    }));
  }

  async getDashboardMetrics(timeRange?: { start: Date; end: Date }): Promise<DashboardMetrics> {
    if (!this.db) throw new Error('Database not initialized');

    let timeFilter = '';
    const params: any[] = [];

    if (timeRange) {
      timeFilter = 'WHERE timestamp >= ? AND timestamp <= ?';
      params.push(timeRange.start.toISOString(), timeRange.end.toISOString());
    }

    // Get buy/sell counts and volumes
    const metricsQuery = `
      SELECT 
        type,
        COUNT(*) as count,
        SUM(amount) as volume
      FROM transactions 
      ${timeFilter}
      GROUP BY type
    `;

    const metricsRows = await this.db.all(metricsQuery, params);

    // Get protocol breakdown
    const protocolQuery = `
      SELECT 
        protocol,
        COUNT(*) as count
      FROM transactions 
      ${timeFilter}
      GROUP BY protocol
    `;

    const protocolRows = await this.db.all(protocolQuery, params);

    // Get active wallets count
    const activeWalletsQuery = `
      SELECT COUNT(DISTINCT wallet_address) as count
      FROM transactions 
      ${timeFilter}
    `;

    const activeWalletsRow = await this.db.get(activeWalletsQuery, params);

    // Get top wallets
    const topWallets = await this.getTopWallets(10);

    const metrics: DashboardMetrics = {
      totalBuys: 0,
      totalSells: 0,
      buyVolume: 0,
      sellVolume: 0,
      activeWallets: activeWalletsRow?.count || 0,
      protocolBreakdown: {},
      topWallets
    };

    // Process metrics
    metricsRows.forEach(row => {
      if (row.type === 'buy') {
        metrics.totalBuys = row.count;
        metrics.buyVolume = row.volume;
      } else {
        metrics.totalSells = row.count;
        metrics.sellVolume = row.volume;
      }
    });

    // Process protocol breakdown
    protocolRows.forEach(row => {
      metrics.protocolBreakdown[row.protocol] = row.count;
    });

    return metrics;
  }

  getDatabase(): Database {
    if (!this.db) throw new Error('Database not initialized');
    return this.db;
  }
}

export const dbManager = new DatabaseManager();