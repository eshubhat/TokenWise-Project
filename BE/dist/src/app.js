"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// backend/src/app.ts
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const http_1 = require("http");
const socket_io_1 = require("socket.io");
const database_1 = require("./config/database");
const solanaService_1 = require("./services/solanaService");
const app = (0, express_1.default)();
const server = (0, http_1.createServer)(app);
const io = new socket_io_1.Server(server, {
    cors: {
        origin: process.env.FRONTEND_URL || "http://localhost:5173",
        methods: ["GET", "POST"]
    }
});
// Middleware
app.use((0, cors_1.default)());
app.use(express_1.default.json());
// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});
// Initialize and get top wallets
app.get('/api/wallets/top', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 60;
        const wallets = await solanaService_1.solanaService.getTopTokenHolders(limit);
        res.json(wallets);
    }
    catch (error) {
        console.error('Error fetching top wallets:', error);
        res.status(500).json({ error: 'Failed to fetch wallets' });
    }
});
// Get wallet details
//@ts-ignore
app.get('/api/wallets/:address', async (req, res) => {
    try {
        const { address } = req.params;
        const transactions = await database_1.dbManager.getTransactions({
            walletAddress: address,
            limit: 100
        });
        const wallets = await database_1.dbManager.getTopWallets(60);
        const wallet = wallets.find(w => w.address === address);
        if (!wallet) {
            return res.status(404).json({ error: 'Wallet not found' });
        }
        res.json({
            wallet,
            transactions,
            stats: {
                totalTransactions: transactions.length,
                totalBuys: transactions.filter(t => t.type === 'buy').length,
                totalSells: transactions.filter(t => t.type === 'sell').length,
                totalVolume: transactions.reduce((sum, t) => sum + t.amount, 0)
            }
        });
    }
    catch (error) {
        console.error('Error fetching wallet details:', error);
        res.status(500).json({ error: 'Failed to fetch wallet details' });
    }
});
// Get transactions with filters
app.get('/api/transactions', async (req, res) => {
    try {
        const { walletAddress, type, startDate, endDate, limit } = req.query;
        const filters = {};
        if (walletAddress)
            filters.walletAddress = walletAddress;
        if (type)
            filters.type = type;
        if (startDate)
            filters.startDate = new Date(startDate);
        if (endDate)
            filters.endDate = new Date(endDate);
        if (limit)
            filters.limit = parseInt(limit);
        const transactions = await database_1.dbManager.getTransactions(filters);
        res.json(transactions);
    }
    catch (error) {
        console.error('Error fetching transactions:', error);
        res.status(500).json({ error: 'Failed to fetch transactions' });
    }
});
// Get dashboard metrics
app.get('/api/dashboard/metrics', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        let timeRange;
        if (startDate && endDate) {
            timeRange = {
                start: new Date(startDate),
                end: new Date(endDate)
            };
        }
        const metrics = await database_1.dbManager.getDashboardMetrics(timeRange);
        res.json(metrics);
    }
    catch (error) {
        console.error('Error fetching dashboard metrics:', error);
        res.status(500).json({ error: 'Failed to fetch metrics' });
    }
});
// Start monitoring endpoint
app.post('/api/monitoring/start', async (req, res) => {
    try {
        const wallets = await database_1.dbManager.getTopWallets(60);
        const walletAddresses = wallets.map(w => w.address);
        await solanaService_1.solanaService.subscribeToWalletTransactions(walletAddresses);
        res.json({
            message: 'Monitoring started',
            walletsCount: walletAddresses.length
        });
    }
    catch (error) {
        console.error('Error starting monitoring:', error);
        res.status(500).json({ error: 'Failed to start monitoring' });
    }
});
// Stop monitoring endpoint
app.post('/api/monitoring/stop', async (req, res) => {
    try {
        await solanaService_1.solanaService.unsubscribeAll();
        res.json({ message: 'Monitoring stopped' });
    }
    catch (error) {
        console.error('Error stopping monitoring:', error);
        res.status(500).json({ error: 'Failed to stop monitoring' });
    }
});
// Export data endpoints
app.get('/api/export/transactions', async (req, res) => {
    try {
        const { format = 'json', startDate, endDate } = req.query;
        const filters = {};
        if (startDate)
            filters.startDate = new Date(startDate);
        if (endDate)
            filters.endDate = new Date(endDate);
        const transactions = await database_1.dbManager.getTransactions(filters);
        if (format === 'csv') {
            const csvHeader = 'signature,timestamp,walletAddress,type,amount,protocol,priceImpact,fee,tokenPrice\n';
            const csvData = transactions.map(t => `${t.signature},${t.timestamp.toISOString()},${t.walletAddress},${t.type},${t.amount},${t.protocol},${t.priceImpact},${t.fee},${t.tokenPrice || 0}`).join('\n');
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename=transactions.csv');
            res.send(csvHeader + csvData);
        }
        else {
            res.json(transactions);
        }
    }
    catch (error) {
        console.error('Error exporting transactions:', error);
        res.status(500).json({ error: 'Failed to export transactions' });
    }
});
app.get('/api/export/wallets', async (req, res) => {
    try {
        const { format = 'json' } = req.query;
        const wallets = await database_1.dbManager.getTopWallets(60);
        if (format === 'csv') {
            const csvHeader = 'address,tokenBalance,solBalance,firstSeen,lastActivity,transactionCount,totalVolume\n';
            const csvData = wallets.map(w => `${w.address},${w.tokenBalance},${w.solBalance},${w.firstSeen.toISOString()},${w.lastActivity.toISOString()},${w.transactionCount},${w.totalVolume}`).join('\n');
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename=wallets.csv');
            res.send(csvHeader + csvData);
        }
        else {
            res.json(wallets);
        }
    }
    catch (error) {
        console.error('Error exporting wallets:', error);
        res.status(500).json({ error: 'Failed to export wallets' });
    }
});
// WebSocket connection handling
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    // Send initial dashboard metrics
    socket.emit('dashboard-metrics', async () => {
        try {
            const metrics = await database_1.dbManager.getDashboardMetrics();
            return metrics;
        }
        catch (error) {
            console.error('Error sending initial metrics:', error);
            return null;
        }
    });
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
    // Handle client requests for specific wallet data
    socket.on('subscribe-wallet', async (walletAddress) => {
        try {
            const transactions = await database_1.dbManager.getTransactions({
                walletAddress,
                limit: 50
            });
            socket.emit('wallet-data', { walletAddress, transactions });
        }
        catch (error) {
            console.error('Error subscribing to wallet:', error);
            socket.emit('error', { message: 'Failed to subscribe to wallet' });
        }
    });
    // Handle requests for real-time metrics
    socket.on('get-metrics', async (timeRange) => {
        try {
            let range;
            if (timeRange) {
                range = {
                    start: new Date(timeRange.start),
                    end: new Date(timeRange.end)
                };
            }
            const metrics = await database_1.dbManager.getDashboardMetrics(range);
            socket.emit('metrics-update', metrics);
        }
        catch (error) {
            console.error('Error getting metrics:', error);
            socket.emit('error', { message: 'Failed to get metrics' });
        }
    });
});
// Real-time updates broadcaster
class RealTimeUpdater {
    constructor() {
        this.updateInterval = null;
        this.lastMetrics = null;
    }
    start() {
        this.updateInterval = setInterval(async () => {
            try {
                const newMetrics = await database_1.dbManager.getDashboardMetrics();
                // Only broadcast if metrics changed significantly
                if (this.hasSignificantChange(newMetrics)) {
                    io.emit('metrics-update', newMetrics);
                    this.lastMetrics = newMetrics;
                }
            }
            catch (error) {
                console.error('Error broadcasting updates:', error);
            }
        }, 5000); // Update every 5 seconds
    }
    stop() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
    }
    hasSignificantChange(newMetrics) {
        if (!this.lastMetrics)
            return true;
        const threshold = 0.05; // 5% change threshold
        const oldTotal = this.lastMetrics.totalBuys + this.lastMetrics.totalSells;
        const newTotal = newMetrics.totalBuys + newMetrics.totalSells;
        if (oldTotal === 0)
            return newTotal > 0;
        const changePercent = Math.abs((newTotal - oldTotal) / oldTotal);
        return changePercent > threshold;
    }
}
const realTimeUpdater = new RealTimeUpdater();
// Initialize application
async function initializeApp() {
    try {
        console.log('Initializing TokenWise API...');
        // Initialize database
        await database_1.dbManager.initialize();
        console.log('Database initialized');
        // Get initial token holders
        console.log('Fetching top token holders...');
        const wallets = await solanaService_1.solanaService.getTopTokenHolders(60);
        console.log(`Found ${wallets.length} top token holders`);
        // Start real-time monitoring
        const walletAddresses = wallets.map(w => w.address);
        await solanaService_1.solanaService.subscribeToWalletTransactions(walletAddresses);
        console.log('Real-time monitoring started');
        // Start real-time updates broadcaster
        realTimeUpdater.start();
        console.log('Real-time updates broadcaster started');
        console.log('TokenWise API initialized successfully');
    }
    catch (error) {
        console.error('Failed to initialize application:', error);
        process.exit(1);
    }
}
// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('Shutting down gracefully...');
    realTimeUpdater.stop();
    await solanaService_1.solanaService.unsubscribeAll();
    process.exit(0);
});
process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    realTimeUpdater.stop();
    await solanaService_1.solanaService.unsubscribeAll();
    process.exit(0);
});
// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    await initializeApp();
});
exports.default = app;
