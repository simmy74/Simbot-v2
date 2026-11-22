const express = require("express");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.static(__dirname));
app.get("/api/status", (_req, res) => {
  res.json({ provider: "Twelve Data", configured: Boolean(process.env.TWELVE_DATA_API_KEY) });
});
app.get("/api/candles", async (req, res) => {
  const symbol = req.query.symbol || "EUR/USD";
  const interval = req.query.interval || "1min";
  const key = process.env.TWELVE_DATA_API_KEY;
  if (!key) return res.status(503).json({ error: "Add TWELVE_DATA_API_KEY to the hosting environment." });
  try {
    const url = new URL("https://api.twelvedata.com/time_series");
    url.search = new URLSearchParams({ symbol, interval, outputsize: "120", apikey: key });
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok || data.status === "error") return res.status(502).json({ error: data.message || "Market-data request failed." });
    res.json(data);
  } catch (e) { res.status(500).json({ error: "Unable to retrieve candles." }); }
});
app.listen(PORT, () => console.log(`SIMBOT running on port ${PORT}`));
