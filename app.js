const $ = id => document.getElementById(id);
const fmt = n => Number.isFinite(n) ? n.toFixed(5) : "—";
function ema(values, period) {
  if (values.length < period) return NaN;
  const k = 2 / (period + 1);
  let result = values.slice(0, period).reduce((a,b)=>a+b,0) / period;
  for (const v of values.slice(period)) result = v*k + result*(1-k);
  return result;
}
function pivots(values, type) {
  const out=[];
  for(let i=2;i<values.length-2;i++){
    const v=values[i];
    if(type==="high" && v>values[i-1]&&v>values[i-2]&&v>=values[i+1]&&v>=values[i+2]) out.push({i,v});
    if(type==="low" && v<values[i-1]&&v<values[i-2]&&v<=values[i+1]&&v<=values[i+2]) out.push({i,v});
  }
  return out;
}
function near(a,b){return Math.abs(a-b)/Math.max(Math.abs(a),Math.abs(b),1e-9)<0.0015}
function journal(){const a=JSON.parse(localStorage.getItem("simbotJournal")||"[]");$("count").textContent=a.length;$("winrate").textContent=a.length?(100*a.filter(x=>x==="win").length/a.length).toFixed(1)+"%":"—";}
async function analyze(){
  $("signal").textContent="ANALYSING…";$("reason").textContent="Requesting market candles.";
  try{
    const interval=$("interval").value;
    const r=await fetch(`/api/candles?symbol=EUR/USD&interval=${interval}`);
    const d=await r.json(); if(!r.ok) throw new Error(d.error||"Market data unavailable");
    const rows=(d.values||[]).slice().reverse();
    const closes=rows.map(x=>Number(x.close)), highs=rows.map(x=>Number(x.high)), lows=rows.map(x=>Number(x.low));
    if(closes.length<30) throw new Error("Not enough candles returned.");
    const e9=ema(closes,9),e21=ema(closes,21),last=rows[rows.length-1];
    const hs=pivots(highs,"high"),ls=pivots(lows,"low");
    const dt=hs.length>=2&&near(hs.at(-1).v,hs.at(-2).v);
    const db=ls.length>=2&&near(ls.at(-1).v,ls.at(-2).v);
    const body=Math.abs(Number(last.close)-Number(last.open)),range=Number(last.high)-Number(last.low);
    const upper=Number(last.high)-Math.max(Number(last.open),Number(last.close));
    const lower=Math.min(Number(last.open),Number(last.close))-Number(last.low);
    const rejection=(range>0 && (upper>body*2 || lower>body*2));
    const recentHigh=Math.max(...highs.slice(-12,-2)),recentLow=Math.min(...lows.slice(-12,-2));
    const choch=Number(last.close)>recentHigh||Number(last.close)<recentLow;
    $("ema9").textContent=fmt(e9);$("ema21").textContent=fmt(e21);
    $("trend").textContent=e9>e21?"Bullish":e9<e21?"Bearish":"Flat";
    $("doubleTop").textContent=dt?"Possible":"Not detected";$("doubleBottom").textContent=db?"Possible":"Not detected";
    $("rejection").textContent=rejection?"Possible":"Not detected";$("choch").textContent=choch?"Possible break":"Not detected";
    let signal="NO TRADE",reason="Wait for clearer alignment between trend, structure and candle reaction.";
    if(e9>e21 && lower>body*1.5 && !dt){signal="CALL SETUP";reason="Bullish EMA alignment with a lower-wick rejection. Confirm on your broker chart."}
    if(e9<e21 && upper>body*1.5 && !db){signal="PUT SETUP";reason="Bearish EMA alignment with an upper-wick rejection. Confirm on your broker chart."}
    $("signal").textContent=signal;$("reason").textContent=reason;
    $("connection").textContent="Data loaded · "+rows.length+" candles";
  }catch(e){$("signal").textContent="NO DATA";$("reason").textContent=e.message;$("connection").textContent="Data unavailable";}
}
$("refresh").addEventListener("click",analyze);
document.querySelectorAll("[data-result]").forEach(b=>b.addEventListener("click",()=>{const a=JSON.parse(localStorage.getItem("simbotJournal")||"[]");a.push(b.dataset.result);localStorage.setItem("simbotJournal",JSON.stringify(a));journal()}));
$("clear").addEventListener("click",()=>{localStorage.removeItem("simbotJournal");journal()});
fetch("/api/status").then(r=>r.json()).then(d=>{if(!d.configured)$("connection").textContent="API key needed";}).catch(()=>{$("connection").textContent="Server not connected"});
journal();analyze();
