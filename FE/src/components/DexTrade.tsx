import React, { useEffect, useState } from "react";
import ReactApexChart from "react-apexcharts";
import type { ApexOptions } from "apexcharts";

const API_BASE = "http://localhost:3000/api";

interface CandlestickPoint {
  x: number; // timestamp
  y: [number, number, number, number]; // [open, high, low, close]
}

interface Props {
  token: string;
}

const DexTradesChart: React.FC<Props> = ({ token }) => {
  const [seriesData, setSeriesData] = useState<CandlestickPoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchTrades = async () => {
      try {
        const res = await fetch(`${API_BASE}/solana/dex-trades?token=${token}`);
        const json = await res.json();

        console.log("data:", json.data);

        if (json.data) {
          const formatted: CandlestickPoint[] = json.data.map((t: any) => ({
            x: new Date(t.Block.Time).getTime(),
            y: [
              parseFloat(t.Trade.open),
              parseFloat(t.Trade.high),
              parseFloat(t.Trade.low),
              parseFloat(t.Trade.close),
            ],
          }));

          setSeriesData(formatted);
        }
      } catch (err) {
        console.error("Error fetching DEX trades:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchTrades();
  }, [token]);

  const options: ApexOptions = {
    chart: {
      type: "candlestick",
      height: 350,
      zoom: { enabled: true },
      toolbar: { show: true },
    },
    title: {
      text: `DEX Candlestick Chart`,
      align: "left",
    },
    xaxis: {
      type: "datetime",
    },
    yaxis: {
      tooltip: {
        enabled: true,
      },
    },
  };

  const series = [
    {
      name: token,
      data: seriesData,
    },
  ];

  if (loading) return <div>Loading DEX trades...</div>;
  if (!seriesData.length) return <div>No trade data available</div>;

  return (
    <div className="bg-white rounded shadow p-4 w-full">
      <ReactApexChart
        options={options}
        series={series as any} // workaround if type mismatch still shows up
        type="candlestick"
        height={350}
      />
    </div>
  );
};

export default DexTradesChart;
