"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDatabaseManager = exports.dbManager = exports.DatabaseManager = void 0;
// backend/src/config/database.ts
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const path_1 = __importDefault(require("path"));
class DatabaseManager {
    constructor(dbPath) {
        this.db = null;
        // Use provided path or default to data directory
        this.dbPath = dbPath || path_1.default.join(process.cwd(), 'data', 'tokenwise.db');
        // Ensure data directory exists
        const dataDir = path_1.default.dirname(this.dbPath);
        if (!require('fs').existsSync(dataDir)) {
            require('fs').mkdirSync(dataDir, { recursive: true });
        }
    }
    initialize() {
        try {
            console.log(`Initializing database at: ${this.dbPath}`);
            this.db = new better_sqlite3_1.default(this.dbPath);
            this.db.pragma('foreign_keys = ON');
            this.db.pragma('journal_mode = WAL');
            this.createTables();
            console.log('Database initialized successfully');
        }
        catch (error) {
            console.error('Database initialization failed:', error);
            throw error;
        }
    }
    async createTables() {
        if (!this.db)
            throw new Error('Database not initialized');
        // Wallets table with comprehensive tracking
        this.db.exec(`
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
        this.db.exec(`
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
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS system_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metric_name TEXT NOT NULL,
        metric_value REAL NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
        // Create performance indexes
        this.db.exec(`
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
        console.log('Database tables and indexes created successfully');
    }
    insertWallet(wallet) {
        if (!this.db)
            throw new Error('Database not initialized');
        try {
            const walletVal = this.db.prepare(`
        INSERT OR REPLACE INTO wallets 
        (address, token_balance, sol_balance, first_seen, last_activity, 
         transaction_count, total_volume, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `);
            walletVal.run(wallet.address, wallet.tokenBalance, wallet.solBalance, wallet.firstSeen, wallet.lastActivity, wallet.transactionCount, wallet.totalVolume);
        }
        catch (error) {
            console.error('Error inserting wallet:', error);
            throw error;
        }
    }
    insertTransaction(transaction) {
        if (!this.db)
            throw new Error('Database not initialized');
        try {
            const transactionVal = this.db.prepare(`
        INSERT OR REPLACE INTO transactions 
        (signature, timestamp, wallet_address, type, amount, protocol, 
         price_impact, fee, token_price, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `);
            transactionVal.run(transaction.signature, transaction.timestamp, transaction.walletAddress, transaction.type, transaction.amount, transaction.protocol, transaction.priceImpact, transaction.fee, transaction.tokenPrice);
            // Update wallet statistics
            this.updateWalletStats(transaction.walletAddress);
        }
        catch (error) {
            console.error('Error inserting transaction:', error);
            throw error;
        }
    }
    updateWalletStats(walletAddress) {
        if (!this.db)
            throw new Error('Database not initialized');
        try {
            const updateWallet = this.db.prepare(`
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
      `);
            updateWallet.run(walletAddress, walletAddress, walletAddress, walletAddress, walletAddress, walletAddress, walletAddress);
        }
        catch (error) {
            console.error('Error updating wallet stats:', error);
            throw error;
        }
    }
    getTopWallets(limit = 60) {
        if (!this.db)
            throw new Error('Database not initialized');
        try {
            const rows = this.db.prepare(`
        SELECT * FROM wallets 
        ORDER BY token_balance DESC 
        LIMIT ?
      `).all(limit);
            return rows.map(row => ({
                address: row.address,
                tokenBalance: row.tokenBalance,
                solBalance: row.solBalance,
                firstSeen: new Date(row.firstSeen),
                lastActivity: new Date(row.lastActivity),
                transactionCount: row.transactionCount,
                totalVolume: row.totalVolume
            }));
        }
        catch (error) {
            console.error('Error fetching top wallets:', error);
            throw error;
        }
    }
    getTransactions(filters) {
        if (!this.db)
            throw new Error('Database not initialized');
        try {
            let query = 'SELECT * FROM transactions WHERE 1=1';
            const params = [];
            if (filters.walletAddress) {
                query += ' AND wallet_address = ?';
                params.push(filters.walletAddress);
            }
            if (filters.type) {
                query += ' AND type = ?';
                params.push(filters.type);
            }
            if (filters.protocol) {
                query += ' AND protocol = ?';
                params.push(filters.protocol);
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
            if (filters.offset) {
                query += ' OFFSET ?';
                params.push(filters.offset);
            }
            const rows = this.db.prepare(query).all(params);
            return rows.map(row => ({
                signature: row.signature,
                timestamp: new Date(row.timestamp),
                walletAddress: row.walletAddress,
                type: row.type,
                amount: row.amount,
                protocol: row.protocol,
                priceImpact: row.priceImpact,
                fee: row.fee,
                tokenPrice: row.tokenPrice
            }));
        }
        catch (error) {
            console.error('Error fetching transactions:', error);
            throw error;
        }
    }
    getDashboardMetrics(timeRange) {
        if (!this.db)
            throw new Error('Database not initialized');
        try {
            let timeFilter = '';
            const params = [];
            if (timeRange) {
                timeFilter = 'WHERE timestamp >= ? AND timestamp <= ?';
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
            const metricsRows = this.db.prepare(metricsQuery).all(params);
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
            const protocolRows = this.db.prepare(protocolQuery).all(params);
            // Get active wallets
            const activeWalletsQuery = `
        SELECT COUNT(DISTINCT wallet_address) as count
        FROM transactions 
        ${timeFilter}
      `;
            const activeWalletsRow = this.db.prepare(activeWalletsQuery).get(params);
            // Get top wallets
            const topWallets = this.getTopWallets(10);
            const metrics = {
                totalBuys: 0,
                totalSells: 0,
                buyVolume: 0,
                sellVolume: 0,
                activeWallets: activeWalletsRow?.count || 0,
                protocolBreakdown: {},
                topWallets
            };
            // Process buy/sell metrics
            metricsRows.forEach(row => {
                if (row.type === 'buy') {
                    metrics.totalBuys = row.count;
                    metrics.buyVolume = row.volume || 0;
                }
                else if (row.type === 'sell') {
                    metrics.totalSells = row.count;
                    metrics.sellVolume = row.volume || 0;
                }
            });
            // Process protocol breakdown
            protocolRows.forEach(row => {
                metrics.protocolBreakdown[row.protocol] = row.count;
            });
            return metrics;
        }
        catch (error) {
            console.error('Error fetching dashboard metrics:', error);
            throw error;
        }
    }
    getWalletStats(walletAddress) {
        if (!this.db)
            throw new Error('Database not initialized');
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
            const walletRow = this.db.prepare(walletQuery).get(walletAddress);
            if (!walletRow) {
                return null;
            }
            const protocolUsageQuery = `
        SELECT protocol, COUNT(*) as count, SUM(amount) as volume
        FROM transactions 
        WHERE wallet_address = ?
        GROUP BY protocol
      `;
            const protocolUsage = this.db.prepare(protocolUsageQuery).all(walletAddress);
            const recentTransactionsQuery = `
        SELECT * FROM transactions 
        WHERE wallet_address = ?
        ORDER BY timestamp DESC
        LIMIT 10
      `;
            const recentTransactions = this.db.prepare(recentTransactionsQuery).all(walletAddress);
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
                    largestTransaction: walletRow.largest_transaction
                },
                stats: {
                    recentTransactions: walletRow.recent_transactions,
                    avgTransactionAmount: walletRow.avg_transaction_amount,
                    maxTransactionAmount: walletRow.max_transaction_amount,
                    firstTransaction: walletRow.first_transaction ? new Date(walletRow.first_transaction) : null,
                    lastTransaction: walletRow.last_transaction ? new Date(walletRow.last_transaction) : null
                },
                protocolUsage: protocolUsage.reduce((acc, row) => {
                    acc[row.protocol] = {
                        count: row.count,
                        volume: row.volume
                    };
                    return acc;
                }, {}),
                recentTransactions: recentTransactions.map(row => ({
                    signature: row.signature,
                    timestamp: new Date(row.timestamp),
                    type: row.type,
                    amount: row.amount,
                    protocol: row.protocol,
                    fee: row.fee
                }))
            };
        }
        catch (error) {
            console.error('Error fetching wallet stats:', error);
            throw error;
        }
    }
    recordSystemMetric(name, value) {
        if (!this.db)
            throw new Error('Database not initialized');
        try {
            const recordSymMetricQ = this.db.prepare(`
        INSERT INTO system_metrics (metric_name, metric_value, timestamp)
        VALUES (?, ?, CURRENT_TIMESTAMP)
      `);
            recordSymMetricQ.run(name, value);
        }
        catch (error) {
            console.error('Error recording system metric:', error);
            throw error;
        }
    }
    async getSystemMetrics(metricName, hours = 24) {
        if (!this.db)
            throw new Error('Database not initialized');
        try {
            let query = `
        SELECT * FROM system_metrics 
        WHERE timestamp >= datetime('now', '-${hours} hours')
      `;
            const params = [];
            if (metricName) {
                query += ' AND metric_name = ?';
                params.push(metricName);
            }
            query += ' ORDER BY timestamp DESC';
            const rows = this.db.prepare(query).all(params);
            return rows.map(row => ({
                id: row.id,
                metricName: row.metric_name,
                metricValue: row.metric_value,
                timestamp: new Date(row.timestamp)
            }));
        }
        catch (error) {
            console.error('Error fetching system metrics:', error);
            throw error;
        }
    }
    async cleanup() {
        if (!this.db)
            return;
        try {
            // Clean up old system metrics (keep last 7 days)
            this.db.prepare(`
        DELETE FROM system_metrics 
        WHERE timestamp < datetime('now', '-7 days')
      `).run();
            // Vacuum database to reclaim space
            this.db.exec('VACUUM');
            console.log('Database cleanup completed');
        }
        catch (error) {
            console.error('Error during database cleanup:', error);
        }
    }
    async close() {
        if (this.db) {
            await this.db.close();
            this.db = null;
            console.log('Database connection closed');
        }
    }
    getDatabase() {
        if (!this.db)
            throw new Error('Database not initialized');
        return this.db;
    }
    async healthCheck() {
        if (!this.db)
            throw new Error('Database not initialized');
        try {
            // Check if database is responsive
            const result = await this.db.prepare('SELECT 1 as test').get();
            if (!result)
                throw new Error('Database not responsive');
            // Count tables
            const tables = await this.db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table'
      `).all();
            const lastTx = await this.db.prepare(`
        SELECT MAX(timestamp) as last_timestamp FROM transactions
      `).get();
            return {
                status: 'healthy',
                tablesCount: tables.length,
                lastTransaction: lastTx?.last_timestamp ? new Date(lastTx.last_timestamp) : undefined
            };
        }
        catch (error) {
            console.error('Database health check failed:', error);
            return {
                status: 'unhealthy',
                tablesCount: 0
            };
        }
    }
}
exports.DatabaseManager = DatabaseManager;
// Singleton instance
exports.dbManager = new DatabaseManager();
// Export for testing with custom path
const createDatabaseManager = (dbPath) => new DatabaseManager(dbPath);
exports.createDatabaseManager = createDatabaseManager;
