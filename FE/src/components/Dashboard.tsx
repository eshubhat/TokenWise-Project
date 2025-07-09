import React, { useState, useEffect, useCallback } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  ResponsiveContainer,
} from "recharts";
import {
  Activity,
  TrendingUp,
  TrendingDown,
  Users,
  RefreshCw,
  Download,
  Eye,
  Filter,
  Calendar,
} from "lucide-react";
import { io, Socket } from "socket.io-client";

// Types
interface Wallet {
  BalanceUpdate?: {
    Holding: string;
    Account: {
      Address: string;
    };
  };
  address: string;
  tokenBalance: number;
  solBalance: number;
  firstSeen: Date;
  lastActivity: Date;
  transactionCount: number;
  totalVolume: number;
}

interface Transaction {
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

interface DashboardMetrics {
  totalBuys: number;
  totalSells: number;
  buyVolume: number;
  sellVolume: number;
  activeWallets: number;
  protocolBreakdown: Record<string, number>;
  topWallets: Wallet[];
}

interface TimeRange {
  start: string;
  end: string;
  label: string;
}

const API_BASE = "http://localhost:3000/api";

const TokenWiseDashboard: React.FC = () => {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [selectedWallet, setSelectedWallet] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>({
    start: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    end: new Date().toISOString(),
    label: "1h",
  });
  const [loading, setLoading] = useState(true);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [walletsPage, setWalletsPage] = useState(1);
  const [transactionsPage, setTransactionsPage] = useState(1);
  const itemsPerPage = 5;

  // Time range options
  const timeRanges: TimeRange[] = [
    {
      start: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      end: new Date().toISOString(),
      label: "1h",
    },
    {
      start: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      end: new Date().toISOString(),
      label: "1d",
    },
    {
      start: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      end: new Date().toISOString(),
      label: "2d",
    },
  ];

  // Initialize socket connection
  useEffect(() => {
    const socketConnection = io("http://localhost:3000");
    setSocket(socketConnection);

    socketConnection.on("connect", () => {
      console.log("Connected to server");
    });

    socketConnection.on("metrics-update", (newMetrics: DashboardMetrics) => {
      setMetrics(newMetrics);
      console.log("newMetrics: ", buySellData);
    });

    socketConnection.on(
      "wallet-data",
      (data: { walletAddress: string; transactions: Transaction[] }) => {
        setTransactions(data.transactions);
      }
    );

    return () => {
      socketConnection.disconnect();
    };
  }, []);

  // Fetch initial data
  useEffect(() => {
    fetchInitialData();
  }, []);

  // Fetch metrics when time range changes
  useEffect(() => {
    fetchMetrics(timeRange);
  }, [timeRange]);

  const fetchWallets = async () => {
    const res = await fetch(`${API_BASE}/wallets/top`);
    const data = await res.json();
    setWallets(data);
  };

  const fetchInitialData = async () => {
    try {
      setLoading(true);

      console.log("i am here1");

      // Fetch top wallets
      const walletsResponse = await fetch(`${API_BASE}/wallets/top`);
      const walletsData = await walletsResponse.json();
      //@ts-ignore
      const rows = walletsData.map((wallet, index) => ({
        Rank: index + 1,
        Address: wallet.BalanceUpdate.Account.Address,
        Holding: wallet.BalanceUpdate.Holding || "0",
      }));
      setWallets(walletsData);
      console.log("i am here2", walletsData);

      // Fetch initial metrics
      await fetchMetrics(timeRange);
      console.log("i am here3");

      // Fetch recent transactions
      const transactionsResponse = await fetch(
        `${API_BASE}/solana/recent-transactions`
      );
      console.log("transaction Resp", transactionsResponse);
      const transactionsData = await transactionsResponse.json();
      setTransactions(
        transactionsData.map((t: any) => ({
          ...t,
          timestamp: new Date(t.timestamp),
        }))
      );
    } catch (error) {
      console.error("Error fetching initial data:", error);
    } finally {
      console.log("i am here4");
      setLoading(false);
    }
  };

  const fetchMetrics = async (range: TimeRange) => {
    console.log("range:", range);
    const res = await fetch(
      `${API_BASE}/solana/metrics?timeRange=${range.label || "1h"}`,
      {
        method: "GET",
      }
    );
    const data = await res.json();
    console.log("metrics:", metrics);
    setMetrics(data);
  };

  const handleWalletClick = (addr: string) => {
    if (addr === selectedWallet) return; // avoid re-subscribe
    setSelectedWallet(addr);
    if (socket) socket.emit("subscribe-wallet", addr);
  };

  const toggleMonitoring = async () => {
    try {
      const endpoint = isMonitoring ? "stop" : "start";
      const response = await fetch(`${API_BASE}/monitoring/${endpoint}`, {
        method: "POST",
      });

      if (response.ok) {
        setIsMonitoring(!isMonitoring);
      }
    } catch (error) {
      console.error("Error toggling monitoring:", error);
    }
  };

  const exportData = async (
    type: "transactions" | "wallets",
    format: "json" | "csv"
  ) => {
    try {
      const url = `${API_BASE}/export/${type}?format=${format}&startDate=${timeRange.start}&endDate=${timeRange.end}`;
      const response = await fetch(url);

      if (format === "csv") {
         // Make CSV string
         //@ts-ignore
      const headers = Object.keys(rows[0]).join(",");
      //@ts-ignore
      const csvRows = rows.map((row) =>
        Object.values(row)
          .map((val) => `"${String(val).replace(/"/g, '""')}"`)
          .join(",")
      );
      const csvContent = [headers, ...csvRows].join("\n");

      // Trigger download
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "wallets.csv";
      link.click();
        window.URL.revokeObjectURL(link.href);
      } else {
        const data = await response.json();
        const blob = new Blob([JSON.stringify(data, null, 2)], {
          type: "application/json",
        });
        const downloadUrl = window.URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = downloadUrl;
        link.download = `${type}.json`;
        link.click();
        window.URL.revokeObjectURL(downloadUrl);
      }
    } catch (error) {
      console.error("Error exporting data:", error);
    }
  };

  const formatAddress = (address: string) => {
    return `${address.slice(0, 4)}...${address.slice(-4)}`;
  };

  const formatNumber = (num: string | number) => {
    if (Number(num) >= 1000000) return `${(Number(num) / 1000000).toFixed(1)}M`;
    if (Number(num) >= 1000) return `${(Number(num) / 1000).toFixed(1)}K`;
    return Number(num).toFixed(2);
  };

  // Prepare chart data
  const protocolChartData = metrics
    ? Object.entries(metrics.protocolBreakdown).map(([protocol, count]) => ({
        protocol: protocol.charAt(0).toUpperCase() + protocol.slice(1),
        count,
        percentage: (
          (count / (metrics.totalBuys + metrics.totalSells)) *
          100
        ).toFixed(1),
      }))
    : [];

  const buySellData = metrics
    ? [
        {
          name: "Buys",
          value: metrics.totalBuys,
          volume: metrics.buyVolume,
          percentage: Number(
            (
              (metrics.totalBuys * 100) /
              (metrics.totalBuys + metrics.totalSells)
            ).toFixed(2)
          ),
        },
        {
          name: "Sells",
          value: metrics.totalSells,
          volume: metrics.sellVolume,
          percentage: Number(
            (
              (metrics.totalSells * 100) /
              (metrics.totalBuys + metrics.totalSells)
            ).toFixed(2)
          ),
        },
      ]
    : [];

  const COLORS = ["#10B981", "#EF4444", "#3B82F6", "#F59E0B", "#8B5CF6"];

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <RefreshCw className="w-8 h-8 animate-spin text-blue-500 mx-auto mb-4" />
          <p className="text-gray-600">Loading TokenWise Dashboard...</p>
        </div>
      </div>
    );
  }

  console.log("Info: ", metrics);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center">
              <Activity className="w-8 h-8 text-blue-500 mr-3" />
              <h1 className="text-2xl font-bold text-gray-900">TokenWise</h1>
              <span className="ml-2 text-sm text-gray-500">
                Real-time Wallet Intelligence
              </span>
            </div>

            <div className="flex items-center gap-4 bg-surface p-4 rounded-lg border border-border sticky top-0 z-10">
              {/* Time Filter */}
              <div>
                <label className="block text-xs text-gray-400">
                  Time Range
                </label>
                <select
                  className="bg-[#121212] border border-border text-sm rounded px-3 py-1"
                  value={timeRange.label}
                  onChange={(e) => {
                    const range = timeRanges.find(
                      (r) => r.label === e.target.value
                    );
                    if (range) setTimeRange(range);
                  }}
                >
                  {timeRanges.map((range) => (
                    <option key={range.label} value={range.label}>
                      {range.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Monitoring */}

              {/* Export Dropdown */}
              <div>
                <label className="block text-xs text-gray-400">Export</label>
                <select
                  onChange={(e) => {
                    const [type, format] = e.target.value.split("-");
                    if (type && format) {
                      exportData(
                        type as "transactions" | "wallets",
                        format as "json" | "csv"
                      );
                    }
                  }}
                  className="bg-[#121212] border border-border text-sm rounded px-3 py-1"
                >
                  <option value="">Export</option>
                  <option value="transactions-csv">Transactions (CSV)</option>
                  <option value="wallets-json">Wallets (JSON)</option>
                </select>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-9xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Metrics Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">Total Buys</p>
                <p className="text-2xl font-bold text-green-600">
                  {metrics?.totalBuys || 0}
                </p>
              </div>
              <TrendingUp className="w-8 h-8 text-green-500" />
            </div>
            <p className="text-xs text-gray-500 mt-2">
              Volume: {formatNumber(metrics?.buyVolume || 0)}
            </p>
          </div>

          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">Total Sells</p>
                <p className="text-2xl font-bold text-red-600">
                  {metrics?.totalSells || 0}
                </p>
              </div>
              <TrendingDown className="w-8 h-8 text-red-500" />
            </div>
            <p className="text-xs text-gray-500 mt-2">
              Volume: {formatNumber(metrics?.sellVolume || 0)}
            </p>
          </div>

          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">
                  Buy/Sell Ratio
                </p>
                <p className="text-2xl font-bold text-purple-600">
                  {metrics && metrics.totalSells > 0
                    ? (metrics.totalBuys / metrics.totalSells).toFixed(2)
                    : "N/A"}
                </p>
              </div>
              <Activity className="w-8 h-8 text-purple-500" />
            </div>
            <p className="text-xs text-gray-500 mt-2">
              {metrics && metrics.totalBuys > metrics.totalSells
                ? "Buy pressure"
                : "Sell pressure"}
            </p>
          </div>
        </div>

        {/* Charts Row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          {/* Buy/Sell Distribution */}
          <div className="bg-white rounded-lg shadow p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">
              Buy/Sell Distribution
            </h3>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={buySellData}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, percentage }) => `${name} (${percentage}%)`}
                  outerRadius={80}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {buySellData.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={COLORS[index % COLORS.length]}
                    />
                  ))}
                </Pie>
                <Tooltip formatter={(value, name) => [value, name]} />
              </PieChart>
            </ResponsiveContainer>
          </div>

          {/* Protocol Usage */}
          <div className="bg-white rounded-lg shadow p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">
              Protocol Usage
            </h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={protocolChartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="protocol" />
                <YAxis />
                <Tooltip />
                <Bar dataKey="count" fill="#3B82F6" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Top Wallets and Recent Transactions */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Top Wallets */}
          <div className="bg-white rounded-lg shadow">
            <div className="p-6 border-b">
              <h3 className="text-lg font-medium text-gray-900">
                Top Token Holders
              </h3>
            </div>
            <div className="overflow-y-auto max-h-96">
              {wallets
                ?.slice(
                  (walletsPage - 1) * itemsPerPage,
                  walletsPage * itemsPerPage
                )
                .map((wallet, index) => (
                  <div
                    key={wallet?.BalanceUpdate?.Account.Address}
                    className="p-4 border-b hover:bg-gray-50 cursor-pointer transition-colors"
                    onClick={() =>
                      handleWalletClick(
                        wallet?.BalanceUpdate?.Account.Address as string
                      )
                    }
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center">
                          <span className="text-sm font-medium text-blue-600">
                            #{index + 1}
                          </span>
                        </div>
                        <div>
                          <p className="font-medium text-gray-900">
                            {formatAddress(
                              wallet?.BalanceUpdate?.Account?.Address as string
                            )}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="font-medium text-gray-900">
                          {formatNumber(wallet?.BalanceUpdate?.Holding || "0")}
                        </p>
                      </div>
                    </div>
                    <span className="text-sm font-medium text-blue-600">
                      #{(walletsPage - 1) * itemsPerPage + index + 1}
                    </span>
                  </div>
                ))}
            </div>
            <div className="flex justify-between items-center p-4 border-t">
              <button
                className="text-sm text-blue-600 disabled:text-gray-400"
                onClick={() => setWalletsPage((prev) => Math.max(prev - 1, 1))}
                disabled={walletsPage === 1}
              >
                Previous
              </button>
              <span className="text-sm">
                Page {walletsPage} of{" "}
                {Math.ceil((wallets?.length || 0) / itemsPerPage)}
              </span>
              <button
                className="text-sm text-blue-600 disabled:text-gray-400"
                onClick={() =>
                  setWalletsPage((prev) =>
                    prev < Math.ceil((wallets.length || 0) / itemsPerPage)
                      ? prev + 1
                      : prev
                  )
                }
                disabled={
                  walletsPage >=
                  Math.ceil((wallets?.length || 0) / itemsPerPage)
                }
              >
                Next
              </button>
            </div>
          </div>

          {/* Recent Transactions */}
          <div className="bg-white rounded-lg shadow">
            <div className="p-6 border-b">
              <h3 className="text-lg font-medium text-gray-900">
                Recent Transactions
              </h3>
              {selectedWallet && (
                <p className="text-sm text-gray-500 mt-1">
                  Showing transactions for {formatAddress(selectedWallet)}
                </p>
              )}
            </div>
            <div className="overflow-y-auto max-h-96">
              {transactions
                .slice(
                  (transactionsPage - 1) * itemsPerPage,
                  transactionsPage * itemsPerPage
                )
                .map((transaction) => (
                  <div key={transaction.signature} className="p-4 border-b">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        <div
                          className={`w-3 h-3 rounded-full ${
                            transaction.type === "buy"
                              ? "bg-green-500"
                              : "bg-red-500"
                          }`}
                        />
                        <div>
                          <p className="font-medium text-gray-900 capitalize">
                            {transaction.type}
                          </p>
                          <p className="text-sm text-gray-500">
                            {formatAddress(transaction.walletAddress)}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="font-medium text-gray-900">
                          {formatNumber(transaction.amount)}
                        </p>
                        <p className="text-sm text-gray-500 capitalize">
                          {transaction.protocol}
                        </p>
                      </div>
                    </div>
                    <p className="text-xs text-gray-400 mt-2">
                      {new Date(transaction.timestamp).toLocaleString()}
                    </p>
                  </div>
                ))}
            </div>
            <div className="flex justify-between items-center p-4 border-t">
              <button
                className="text-sm text-blue-600 disabled:text-gray-400"
                onClick={() =>
                  setTransactionsPage((prev) => Math.max(prev - 1, 1))
                }
                disabled={transactionsPage === 1}
              >
                Previous
              </button>
              <span className="text-sm">
                Page {transactionsPage} of{" "}
                {Math.ceil(transactions.length / itemsPerPage)}
              </span>
              <button
                className="text-sm text-blue-600 disabled:text-gray-400"
                onClick={() =>
                  setTransactionsPage((prev) =>
                    prev < Math.ceil(transactions.length / itemsPerPage)
                      ? prev + 1
                      : prev
                  )
                }
                disabled={
                  transactionsPage >=
                  Math.ceil(transactions.length / itemsPerPage)
                }
              >
                Next
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TokenWiseDashboard;
