# SIMBOT V2 — updated analysis dashboard

Mobile-friendly EUR/USD technical-analysis and paper-testing app.

## Updates in this version
- Responsive Japanese candlestick chart with EMA 9 and EMA 21 overlays.
- Hover/touch inspection readout for candle OHLC and EMA values.
- Strict signal gate: a fresh EMA 9/21 crossover, a double-top/bottom neckline breakout, and a same-direction rejection candle must all agree. Otherwise the result is NO TRADE.
- Basic structure-break proxy and local paper-trade journal.

## Deploy
1. Replace the files in the existing `simmy74/Simbot-v2` GitHub repository with these updated files.
2. Keep `TWELVE_DATA_API_KEY` configured in Railway Variables. Never commit the actual key.
3. Railway should deploy from `main`. Check deployment logs and then open the existing public domain.

## Important limitations
This is an experimental implementation, not a validated profitable strategy. Pattern and CHoCH detection are simplified rule-based approximations; the current final API candle may still be forming, so a production-quality version should explicitly exclude incomplete candles using provider timestamps. Twelve Data prices/timing may differ from Pocket Option. Use paper testing only; no automatic trading is implemented. Binary options are high risk.
