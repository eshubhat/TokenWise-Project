// backend/src/app.ts
import express, { Request, Response } from "express";
import cors from "cors";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { dbManager } from "./config/database";
import {
  solanaService,
  fetchRecentTransactions,
} from "./services/solanaService";
import { DashboardMetrics } from "./types";
import {
  parseISO,
  format,
  startOfMinute,
  startOfHour,
  startOfDay,
} from "date-fns";
import dotenv from "dotenv";

const app = express();
const server = createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    methods: ["GET", "POST"],
  },
});

// Middleware
dotenv.config();
app.use(cors());
app.use(express.json());

function getBucketTime(timestamp: string, range: string) {
  const date = parseISO(timestamp);
  if (range === "1h")
    return format(
      startOfMinute(date.setMinutes(Math.floor(date.getMinutes() / 10) * 10)),
      "yyyy-MM-dd HH:mm"
    );
  if (range === "24h") return format(startOfHour(date), "yyyy-MM-dd HH:00");
  if (range === "7d") return format(startOfDay(date), "yyyy-MM-dd");
  return format(date, "yyyy-MM-dd HH:mm");
}

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// Initialize and get top wallets
app.get("/api/wallets/top", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 60;
    const now = Date.now();

    const myHeaders = new Headers();
    myHeaders.append("Content-Type", "application/json");
    myHeaders.append(
      "Authorization",
      `Bearer ${process.env.BITQUERY_TOKEN}`
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

    res.json(data);
  } catch (error) {
    console.error("Error fetching top wallets:", error);
    res.status(500).json({ error: "Failed to fetch wallets" });
  }
});

// Get wallet details
// @ts-ignore
app.get("/api/wallets/:address", async (req, res) => {
  try {
    const { address } = req.params;
    const transactions = await dbManager.getTransactions({
      walletAddress: address,
      limit: 100,
    });

    const wallets = await dbManager.getTopWallets(60);
    const wallet = wallets.find((w) => w.address === address);

    if (!wallet) {
      return res.status(404).json({ error: "Wallet not found" });
    }

    res.json({
      wallet,
      transactions,
      stats: {
        totalTransactions: transactions.length,
        totalBuys: transactions.filter((t) => t.type === "buy").length,
        totalSells: transactions.filter((t) => t.type === "sell").length,
        totalVolume: transactions.reduce((sum, t) => sum + t.amount, 0),
      },
    });
  } catch (error) {
    console.error("Error fetching wallet details:", error);
    res.status(500).json({ error: "Failed to fetch wallet details" });
  }
});

// Get transactions with filters
app.get("/api/transactions", async (req, res) => {
  try {
    const { walletAddress, type, startDate, endDate, limit } = req.query;

    const filters: any = {};

    if (walletAddress) filters.walletAddress = walletAddress as string;
    if (type) filters.type = type as "buy" | "sell";
    if (startDate) filters.startDate = new Date(startDate as string);
    if (endDate) filters.endDate = new Date(endDate as string);
    if (limit) filters.limit = parseInt(limit as string);

    const transactions = await dbManager.getTransactions(filters);
    res.json(transactions);
  } catch (error) {
    console.error("Error fetching transactions:", error);
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

// Get dashboard metrics
app.get("/api/dashboard/metrics", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    let timeRange;
    if (startDate && endDate) {
      timeRange = {
        start: new Date(startDate as string),
        end: new Date(endDate as string),
      };
    }

    const metrics = await dbManager.getDashboardMetrics(timeRange);
    res.json(metrics);
  } catch (error) {
    console.error("Error fetching dashboard metrics:", error);
    res.status(500).json({ error: "Failed to fetch metrics" });
  }
});

// Start monitoring endpoint
app.post("/api/monitoring/start", async (req, res) => {
  try {
    const wallets = await dbManager.getTopWallets(60);
    const walletAddresses = wallets.map((w) => w.address);

    await solanaService.subscribeToWalletTransactions(walletAddresses);

    res.json({
      message: "Monitoring started",
      walletsCount: walletAddresses.length,
    });
  } catch (error) {
    console.error("Error starting monitoring:", error);
    res.status(500).json({ error: "Failed to start monitoring" });
  }
});

// Stop monitoring endpoint
app.post("/api/monitoring/stop", async (req, res) => {
  try {
    await solanaService.unsubscribeAll();
    res.json({ message: "Monitoring stopped" });
  } catch (error) {
    console.error("Error stopping monitoring:", error);
    res.status(500).json({ error: "Failed to stop monitoring" });
  }
});

// Export data endpoints
app.get("/api/export/transactions", async (req, res) => {
  try {
    const { format = "json", startDate, endDate } = req.query;

    const filters: any = {};
    if (startDate) filters.startDate = new Date(startDate as string);
    if (endDate) filters.endDate = new Date(endDate as string);

    const transactions = await dbManager.getTransactions(filters);

    if (format === "csv") {
      const csvHeader =
        "signature,timestamp,walletAddress,type,amount,protocol,priceImpact,fee,tokenPrice\n";
      const csvData = transactions
        .map(
          (t) =>
            `${t.signature},${t.timestamp.toISOString()},${t.walletAddress},${
              t.type
            },${t.amount},${t.protocol},${t.priceImpact},${t.fee},${
              t.tokenPrice || 0
            }`
        )
        .join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        "attachment; filename=transactions.csv"
      );
      res.send(csvHeader + csvData);
    } else {
      res.json(transactions);
    }
  } catch (error) {
    console.error("Error exporting transactions:", error);
    res.status(500).json({ error: "Failed to export transactions" });
  }
});

app.get("/api/export/wallets", async (req, res) => {
  try {
    const { format = "json" } = req.query;
    const wallets = await dbManager.getTopWallets(60);

    if (format === "csv") {
      const csvHeader =
        "address,tokenBalance,solBalance,firstSeen,lastActivity,transactionCount,totalVolume\n";
      const csvData = wallets
        .map(
          (w) =>
            `${w.address},${w.tokenBalance},${
              w.solBalance
            },${w.firstSeen.toISOString()},${w.lastActivity.toISOString()},${
              w.transactionCount
            },${w.totalVolume}`
        )
        .join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=wallets.csv");
      res.send(csvHeader + csvData);
    } else {
      res.json(wallets);
    }
  } catch (error) {
    console.error("Error exporting wallets:", error);
    res.status(500).json({ error: "Failed to export wallets" });
  }
});

app.get("/api/solana/dex-trades", async (req, res) => {
  console.log("Dex api hit!\n\n", process.env.BITQUERY_TOKEN);
  const token = req.query.token as string;
  if (!token) res.status(400).json({ error: "Token address required" });

  try {
    const cached = await dbManager.getCachedDexTrades(token, 48); // past 2 days
    if (cached.length > 0) {
      res.json({ source: "cache", data: cached });
    }

    // Fetch from Bitquery
    const bitqueryQuery = {
      query: `{
        Solana {
          DEXTradeByTokens(
            limit: { count: 10000 }
            orderBy: {descendingByField: "Block_Time"}
            where: {
              Trade: { Currency: { MintAddress: { is: "${token}" } } }
            }
          ) {
            Block { Time }
            volume: sum(of: Trade_Amount)
            Trade {
              high: Price(maximum: Trade_Price)
              low: Price(minimum: Trade_Price)
              open: Price(minimum: Trade_Price)
              close: Price(maximum: Trade_Price)
            }
          }
        }
      }`,
      variables: "{}",
    };

    const bitqueryRes = await fetch("https://streaming.bitquery.io/eap", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.BITQUERY_TOKEN}`,
      },
      body: JSON.stringify(bitqueryQuery),
    });

    const result = await bitqueryRes.json();
    console.log("result :", result);
    const trades = result?.data?.Solana?.DEXTradeByTokens ?? [];

    for (const t of trades) {
      await dbManager.insertDexTrade(token, {
        timestamp: t.Block.Timefield,
        open: t.Trade.open,
        high: t.Trade.high,
        low: t.Trade.low,
        close: t.Trade.close,
        volume: t.volume,
      });
    }

    res.json({ source: "api", data: trades });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch DEX trades" });
  }
});


app.get("/api/solana/recent-transactions", async (req, res) => {
  try {
    const tokenAddress = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
    const recentTxns = await fetchRecentTransactions(tokenAddress);
    res.json(recentTxns);
  } catch (err) {
    console.error("Error fetching recent transactions:", err);
    res.status(500).json({ error: "Failed to fetch recent transactions" });
  }
});

app.get("/api/solana/metrics", async (req, res) => {
  try {
    const address = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
    const range = req.query.timeRange || "1h";

    console.log("range: ", range)
     const now = new Date();
    const count = (() => {
      switch (range) {
        case "1h":
          return 1000
        case "1d":
          return 16000;
        case "2d":
        default:
          return 50000;
      }
    })();
    // if (!address) return res.status(400).json({ error: "Missing token address" });

    const myHeaders = new Headers();
    myHeaders.append("Content-Type", "application/json");
    myHeaders.append(
      "Authorization",
      `Bearer ${process.env.BITQUERY_TOKEN}`
    );

    const raw = JSON.stringify({
      query:
        `query LatestTrades {\n  Solana {\n    DEXTradeByTokens(\n      orderBy: {descending: Block_Time}\n      limit: {count: ${count}}\n      where: {Trade: {Currency: {MintAddress: {is: "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump"}}, Side: {Currency: {MintAddress: {in: ["", "So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm"]}}}}}\n    ) {\n      Block {\n        Time\n      }\n      Transaction {\n        Signature\n      }\n      Trade {\n        Market {\n          MarketAddress\n        }\n        Dex {\n          ProtocolName\n          ProtocolFamily\n        }\n        AmountInUSD\n        PriceInUSD\n        Amount\n        Currency {\n          Name\n        }\n        Side {\n          Type\n          Currency {\n            Symbol\n            MintAddress\n            Name\n          }\n          AmountInUSD\n          Amount\n        }\n      }\n    }\n  }\n}\n`,
      variables: "{}",
    });

    const response = await fetch("https://streaming.bitquery.io/eap", {
      method: "POST",
      headers: myHeaders,
      body: raw,
      redirect: "follow",
    });

    const data = await response.json();
    const trades = data?.data?.Solana?.DEXTradeByTokens || [];

    let totalBuys = 0;
    let totalSells = 0;
    let buyVolume = 0;
    let sellVolume = 0;
    const protocolBreakdown: Record<string, number> = {};

    // console.log("trades:", trades)

    for (const trade of trades) {
      const side = trade.Trade.Side.Type?.toLowerCase(); // "buy" or "sell"
      const amountUSD = parseFloat(trade.Trade.Side.AmountInUSD || "0");
      const protocol = trade.Trade.Dex.ProtocolName?.toLowerCase() || "unknown";
      // console.log("side:", side);

      if (side === "buy") {
        totalBuys++;
        buyVolume += amountUSD;
      } else if (side === "sell") {
        totalSells++;
        sellVolume += amountUSD;
      }

      protocolBreakdown[protocol] = (protocolBreakdown[protocol] || 0) + 1;
    }

    console.log("limit:", count)

    console.log(`let totalBuys = 0;
    let totalSells = 0;
    let buyVolume = 0;
    let sellVolume = 0;`, totalBuys,"/n", totalSells,"\n", buyVolume,"\n", sellVolume)

    const metrics = {
      totalBuys,
      totalSells,
      buyVolume,
      sellVolume,
      activeWallets: 0, // not supported by Bitquery directly
      protocolBreakdown,
    };

    console.log("metrics:");

    res.json(metrics);
  } catch (err) {
    console.error("Error fetching metrics:", err);
    res.status(500).json({ error: "Failed to fetch metrics" });
  }
});

// GET /api/solana/market-insights

app.get("/api/solana/market-insights", async (req, res) => {
  try {
    const range = req.query.range || "7d";
    const now = new Date();
    const dateFrom = (() => {
      switch (range) {
        case "1h":
          return new Date(now.getTime() - 1 * 60 * 60 * 1000);
        case "2d":
          return new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
        case "24h":
        default:
          return new Date(now.getTime() - 24 * 60 * 60 * 1000);
      }
    })().toISOString();

    console.log("time: ", now);

    const limitByRange = {
      "1h": 80000,
      "24h": 800000,
      "2d": 500000,
    };

    //@ts-ignore
    const tradeLimit = limitByRange[range as string] || 100;

    const response = await fetch("https://streaming.bitquery.io/eap", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.BITQUERY_TOKEN}`,
      },
      body: JSON.stringify({
        query: `query MarketTrends {
          Solana {
            DEXTradeByTokens(
              orderBy: {descending: Block_Time}
              limit: {count: ${tradeLimit}}
              where: {
                Block: { Time: { since: "${dateFrom}"} }
                Trade: { Currency: { MintAddress: { is: "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump" } } }
              }
            ) {
              Block { Time }
              Trade {
                Dex { ProtocolName }
                Side { Type, AmountInUSD }
              }
            }
          }
        }`,
      }),
    });

    const result = await response.json();
    const trades = result?.data?.Solana?.DEXTradeByTokens || [];

    const aggregatedTrend: Record<string, { buy: number; sell: number }> = {};
    const protocolBreakdown: Record<string, number> = {};

    trades.forEach((t: any) => {
      const timestamp = t.Block.Time;
      const side = t.Trade.Side.Type.toLowerCase();
      const volume = parseFloat(t.Trade.Side.AmountInUSD || "0");
      const protocol = t.Trade.Dex.ProtocolName.toLowerCase();

      const bucket = getBucketTime(timestamp, range as string);

      if (!aggregatedTrend[bucket]) {
        aggregatedTrend[bucket] = { buy: 0, sell: 0 };
      }
      if (side === "buy") {
        aggregatedTrend[bucket].buy += volume;
      } else if (side === "sell") {
        aggregatedTrend[bucket].sell += volume;
      }

      protocolBreakdown[protocol] = (protocolBreakdown[protocol] || 0) + 1;
    });

    const sortedBuckets = Object.keys(aggregatedTrend).sort(); // Ensure chronological order

    const trend = {
      timestamps: sortedBuckets,
      buyVolumes: sortedBuckets.map((b) => aggregatedTrend[b].buy),
      sellVolumes: sortedBuckets.map((b) => aggregatedTrend[b].sell),
    };

    res.json({ trend, protocolBreakdown });
  } catch (error) {
    console.error("Error fetching market insights:", error);
    res.status(500).json({ error: "Failed to fetch market insights" });
  }
});

// WebSocket connection handling
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // Send initial dashboard metrics
  socket.emit("dashboard-metrics", async () => {
    try {
      const metrics = await dbManager.getDashboardMetrics();
      return metrics;
    } catch (error) {
      console.error("Error sending initial metrics:", error);
      return null;
    }
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });

  // Handle client requests for specific wallet data
  socket.on("subscribe-wallet", async (walletAddress: string) => {
    try {
      const transactions = await dbManager.getTransactions({
        walletAddress,
        limit: 50,
      });
      socket.emit("wallet-data", { walletAddress, transactions });
    } catch (error) {
      console.error("Error subscribing to wallet:", error);
      socket.emit("error", { message: "Failed to subscribe to wallet" });
    }
  });

  // Handle requests for real-time metrics
  socket.on(
    "get-metrics",
    async (timeRange?: { start: string; end: string }) => {
      try {
        let range;
        if (timeRange) {
          range = {
            start: new Date(timeRange.start),
            end: new Date(timeRange.end),
          };
        }
        const metrics = await dbManager.getDashboardMetrics(range);
        socket.emit("metrics-update", metrics);
      } catch (error) {
        console.error("Error getting metrics:", error);
        socket.emit("error", { message: "Failed to get metrics" });
      }
    }
  );
});

// Real-time updates broadcaster
class RealTimeUpdater {
  private updateInterval: ReturnType<typeof setInterval> | null = null;
  private lastMetrics: DashboardMetrics | null = null;

  start(): void {
    this.updateInterval = setInterval(async () => {
      try {
        const newMetrics = await dbManager.getDashboardMetrics();

        // Only broadcast if metrics changed significantly
        if (this.hasSignificantChange(newMetrics)) {
          io.emit("metrics-update", newMetrics);
          this.lastMetrics = newMetrics;
        }
      } catch (error) {
        console.error("Error broadcasting updates:", error);
      }
    }, 5000); // Update every 5 seconds
  }

  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  private hasSignificantChange(newMetrics: DashboardMetrics): boolean {
    if (!this.lastMetrics) return true;

    const threshold = 0.05; // 5% change threshold
    const oldTotal = this.lastMetrics.totalBuys + this.lastMetrics.totalSells;
    const newTotal = newMetrics.totalBuys + newMetrics.totalSells;

    if (oldTotal === 0) return newTotal > 0;

    const changePercent = Math.abs((newTotal - oldTotal) / oldTotal);
    return changePercent > threshold;
  }
}

const realTimeUpdater = new RealTimeUpdater();

// Initialize application
async function initializeApp(): Promise<void> {
  try {
    console.log("Initializing TokenWise API...");

    // Initialize database
    await dbManager.initialize();
    console.log("Database initialized");

    // Get initial token holders
    console.log("Fetching top token holders...");
    const wallets = await solanaService.getTopTokenHolders(60);
    console.log(`Found ${wallets.length} top token holders`);

    // Start real-time monitoring
    const walletAddresses = wallets.map((w) => w.address);
    // await solanaService.subscribeToWalletTransactions(walletAddresses);
    console.log("Real-time monitoring started");

    // Start real-time updates broadcaster
    realTimeUpdater.start();
    console.log("Real-time updates broadcaster started");

    console.log("TokenWise API initialized successfully");
  } catch (error) {
    console.error("Failed to initialize application:", error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("Shutting down gracefully...");
  realTimeUpdater.stop();
  await solanaService.unsubscribeAll();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("Shutting down gracefully...");
  realTimeUpdater.stop();
  await solanaService.unsubscribeAll();
  process.exit(0);
});

// Start server
const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await initializeApp();
});

export default app;
