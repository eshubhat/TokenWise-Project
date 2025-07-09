// This is a rewritten version of TokenWiseDashboard using Chart.js instead of Recharts
// Includes setup for a Solana Market Trend Insights dashboard using REST APIs only

import React, { useEffect, useState } from "react";
import {
  Chart as ChartJS,
  ArcElement,
  Tooltip,
  Legend,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  TimeScale,
  LineElement,
  PointElement
} from "chart.js";
import { Bar, Pie, Line } from "react-chartjs-2";
import "chartjs-adapter-date-fns";

ChartJS.register(
  ArcElement,
  Tooltip,
  Legend,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  TimeScale,
  LineElement,
  PointElement
);

const API_BASE = "http://localhost:3000/api";

const MarketInsightsDashboard = () => {
  const [trendData, setTrendData] = useState<any>(null);
  const [protocolData, setProtocolData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [timeRange, setTimeRange] = useState("24h");

  useEffect(() => {
    fetchMarketTrends(timeRange);
  }, [timeRange]);

  const fetchMarketTrends = async (range: string) => {
    try {
      const res = await fetch(`${API_BASE}/solana/market-insights?range=${range}`);
      const data = await res.json();
      console.log("trend: ", data?.trend);
      setTrendData(data.trend);
      setProtocolData(data.protocolBreakdown);
    } catch (err) {
      console.error("Failed to load market trends", err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <p className="text-center mt-10">Loading market trends...</p>;

  const lineChartData = {
    labels: trendData.timestamps,
    datasets: [
      {
        label: "Buy Volume (USD)",
        data: trendData.buyVolumes,
        fill: false,
        borderColor: "#10B981",
        tension: 0.1,
      },
      {
        label: "Sell Volume (USD)",
        data: trendData.sellVolumes,
        fill: false,
        borderColor: "#EF4444",
        tension: 0.1,
      }
    ]
  };

  const barChartData = {
    labels: Object.keys(protocolData),
    datasets: [
      {
        label: "Trades by Protocol",
        data: Object.values(protocolData),
        backgroundColor: "#3B82F6"
      }
    ]
  };

  return (
    <div className="max-w-6xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-6">Solana Market Insights</h1>

      <div className="mb-4 rounded-4xl">
        <select
          className="border px-3 py-2 rounded bg-black"
          value={timeRange}
          onChange={(e) => setTimeRange(e.target.value)}
        >
          <option value="1h">Last 1 Hour</option>
          <option value="24h">Last 24 Hours</option>
          <option value="7d">Last 7 Days</option>
        </select>
      </div>

      <div className="mb-10 bg-white p-4 shadow rounded">
        <h2 className="text-lg font-semibold mb-2">Volume Trends</h2>
        <Line data={lineChartData} options={{ responsive: true }} />
      </div>

      <div className="bg-white p-4 shadow rounded">
        <h2 className="text-lg font-semibold mb-2">DEX Protocol Usage</h2>
        <Bar data={barChartData} options={{ responsive: true }} />
      </div>
    </div>
  );
};

export default MarketInsightsDashboard;
