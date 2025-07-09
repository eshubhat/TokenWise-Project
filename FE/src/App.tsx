import { useState } from "react";
import TokenWiseDashboard from "./components/Dashboard";
import DexTradesChart from "./components/DexTrade";
import MarketInsightsDashboard from "./components/SolanaMarketTrends";

function App() {
  const [activeTab, setActiveTab] = useState<string>("Dashboard");
  return (
    <>
      <div className="bg-[#0e0e0e] text-gray-100 min-h-screen w-[98.9vw]">
        <div className="flex space-x-6 border-b border-gray-700 mb-6">
          {["Dashboard", "Market"].map((tab) => (
            <button
              key={tab}
              className={`pb-2 px-4 text-sm font-medium ${
                activeTab === tab
                  ? "border-b-2 border-blue-500 text-white"
                  : "text-gray-400"
              }`}
              onClick={() => setActiveTab(tab)}
            >
              {tab}
            </button>
          ))}
        </div>
        {activeTab === "Dashboard" && <TokenWiseDashboard />}
        {activeTab === "Market" && <MarketInsightsDashboard />}
        {activeTab === "DEX" && (
          <div className="bg-surface p-4 rounded-lg border border-border">
            <DexTradesChart token="9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump" />
          </div>
        )}
      </div>
    </>
  );
}

export default App;
