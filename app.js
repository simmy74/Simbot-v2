const $ = id => document.getElementById(id);
const DEFAULT_PAIRS = ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD"];
let PAIRS = [...DEFAULT_PAIRS];
let visiblePairs = [...DEFAULT_PAIRS];
let pairCursor = 0;
let scanMode = "STRICT";
const fmt = n => Number.isFinite(n) ? n.toFixed(5) : "—";
let chartRows = [], chartE9 = [], chartE21 = [], chartRange = null;
let activePair = "EUR/USD";
let results = {};
let alertTimer = null;
let audioContext = null;
let serviceWorkerRegistration = null;
let scanAllBusy = false;
const busyPairs = new Set();
const HISTORY_KEY = "simbotSignalHistoryV1";
const HISTORY_LIMIT = 150;

function emaSeries(a, p) {
  const out = Array(a.length).fill(NaN);
  if (a.length < p) return out;
  let v = a.slice(0, p).reduce((x, y) => x + y, 0) / p;
  out[p - 1] = v;
  const k = 2 / (p + 1);
  for (let i = p; i < a.length; i++) { v = a[i] * k + v * (1 - k); out[i] = v; }
  return out;
}
function pivots(a, type) {
  const out = [];
  for (let i = 2; i < a.length - 2; i++) {
    const v = a[i];
    if (type === "high" && v > a[i-1] && v > a[i-2] && v >= a[i+1] && v >= a[i+2]) out.push({i, v});
    if (type === "low" && v < a[i-1] && v < a[i-2] && v <= a[i+1] && v <= a[i+2]) out.push({i, v});
  }
  return out;
}
function near(a, b) { return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-9) <= 0.001; }
function findPattern(hs, ls, closes) {
  const tops = hs.slice(-6), bottoms = ls.slice(-6);
  let top = null, bottom = null;
  if (tops.length >= 2) {
    const a = tops.at(-2), b = tops.at(-1);
    if (b.i - a.i >= 5 && near(a.v, b.v)) {
      const neckline = Math.min(...closes.slice(a.i, b.i + 1));
      if (closes.at(-1) < neckline) top = {a, b, neckline};
    }
  }
  if (bottoms.length >= 2) {
    const a = bottoms.at(-2), b = bottoms.at(-1);
    if (b.i - a.i >= 5 && near(a.v, b.v)) {
      const neckline = Math.max(...closes.slice(a.i, b.i + 1));
      if (closes.at(-1) > neckline) bottom = {a, b, neckline};
    }
  }
  return {top, bottom};
}
function candleReject(c, direction) {
  const o = +c.open, h = +c.high, l = +c.low, cl = +c.close;
  const body = Math.abs(cl - o), range = h - l;
  if (!(range > 0)) return false;
  const upper = h - Math.max(o, cl), lower = Math.min(o, cl) - l;
  const safeBody = Math.max(body, range * .05);
  return direction === "CALL"
    ? lower >= safeBody * 2 && cl > o && cl >= l + range * .6
    : upper >= safeBody * 2 && cl < o && cl <= l + range * .4;
}
function candleTime(c) {
  const raw = c.datetime || c.date || c.time || "";
  if (!raw) return "Unavailable";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? String(raw) : d.toLocaleString();
}
function calculateExpiry(rows, e9, e21, last, signal) {
  if (!signal || signal === "NO TRADE") return {minutes:null, score:null, reason:"No confirmed signal; expiry is not suggested."};
  const close = +last.close, range = Math.max(0, +last.high - +last.low);
  const body = Math.abs(+last.close - +last.open);
  const candleQuality = range > 0 ? Math.min(1, body / range) : 0;
  const gap = Math.abs(e9.at(-1) - e21.at(-1)) / Math.max(Math.abs(close), 1e-9);
  const gapScore = Math.min(1, gap / 0.0015);
  const recent = rows.slice(-8);
  const ranges = recent.map(c => +c.high - +c.low).filter(Number.isFinite);
  const avgRange = ranges.length ? ranges.reduce((a,b)=>a+b,0)/ranges.length : range;
  const volatilityRatio = avgRange > 0 ? range / avgRange : 1;
  const volatilityScore = volatilityRatio >= .65 && volatilityRatio <= 1.6 ? 1 : .55;
  const score = Math.round(55 + gapScore*20 + candleQuality*15 + volatilityScore*10);
  let minutes = 1;
  if (score >= 82 && gapScore >= .55 && volatilityScore > .7) minutes = 5;
  else if (score >= 70) minutes = 3;
  return {minutes, score:Math.min(95,score), reason:`Rule-based estimate: EMA separation, candle body and recent volatility favour ${minutes} minute${minutes===1?"":"s"}.`};
}

function rsiValue(values, period=14) {
  if(values.length < period+1) return 50;
  let gains=0, losses=0;
  for(let i=values.length-period;i<values.length;i++){const d=values[i]-values[i-1];if(d>0)gains+=d;else losses-=d;}
  if(losses===0)return 100;
  const rs=(gains/period)/(losses/period);
  return 100-(100/(1+rs));
}
function atrValue(rows, period=14) {
  const tr=[];
  for(let i=1;i<rows.length;i++){const c=rows[i],p=rows[i-1];tr.push(Math.max(+c.high-+c.low,Math.abs(+c.high-+p.close),Math.abs(+c.low-+p.close)));}
  const a=tr.slice(-period);return a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
}
function marketStructure(rows, hs, ls) {
  const highP=pivots(hs,"high"), lowP=pivots(ls,"low"), last=rows.at(-1);
  const ph=highP.at(-1), pl=lowP.at(-1), prevH=highP.at(-2), prevL=lowP.at(-2);
  const close=+last.close, priorClose=+(rows.at(-2)?.close||close);
  let structure="Range / not confirmed", bias="NEUTRAL", event="None";
  const bullish=ph&&prevH&&pl&&prevL&&ph.v>prevH.v&&pl.v>prevL.v;
  const bearish=ph&&prevH&&pl&&prevL&&ph.v<prevH.v&&pl.v<prevL.v;
  if(bullish){structure="Higher highs + higher lows";bias="BULLISH";}
  if(bearish){structure="Lower highs + lower lows";bias="BEARISH";}
  if(ph&&priorClose<=ph.v&&close>ph.v){event=bias==="BEARISH"?"Bullish CHoCH":"Bullish BOS";bias="BULLISH";}
  else if(pl&&priorClose>=pl.v&&close<pl.v){event=bias==="BULLISH"?"Bearish CHoCH":"Bearish BOS";bias="BEARISH";}
  let sweep="None";
  if(ph&&+last.high>ph.v&&close<ph.v)sweep="Buy-side liquidity sweep";
  if(pl&&+last.low<pl.v&&close>pl.v)sweep="Sell-side liquidity sweep";
  // A potential order block is the last opposite candle before a recent close through a swing.
  let orderBlock="Not detected";
  if(event!=="None"){
    const dir=event.startsWith("Bullish")?"BULLISH":"BEARISH";
    for(let i=rows.length-2;i>=Math.max(0,rows.length-8);i--){const c=rows[i];if((dir==="BULLISH"&&+c.close<+c.open)||(dir==="BEARISH"&&+c.close>+c.open)){orderBlock=`Potential ${dir.toLowerCase()} zone ${(+c.low).toFixed(5)}–${(+c.high).toFixed(5)}`;break;}}
  }
  return {structure,bias,event,sweep,orderBlock, swingHigh:ph?.v??null,swingLow:pl?.v??null};
}
function predictor5m(rows,e9,e21,structure) {
  const closes=rows.map(c=>+c.close), last=closes.at(-1), prev=closes.at(-4)||last;
  const slope=e9.at(-1)-e9.at(-4), momentum=last-prev, rsi=rsiValue(closes), atr=atrValue(rows);
  const latestRange=+rows.at(-1).high-+rows.at(-1).low, volatilityRatio=atr>0?latestRange/atr:1;
  let score=0,notes=[];
  if(e9.at(-1)>e21.at(-1)){score++;notes.push("EMA trend up");}else if(e9.at(-1)<e21.at(-1)){score--;notes.push("EMA trend down");}
  if(slope>0){score++;notes.push("EMA 9 rising");}else if(slope<0){score--;notes.push("EMA 9 falling");}
  if(momentum>0){score++;notes.push("recent momentum up");}else if(momentum<0){score--;notes.push("recent momentum down");}
  if(rsi>=55&&rsi<75)score++;else if(rsi<=45&&rsi>25)score--;
  if(structure.bias==="BULLISH")score++;if(structure.bias==="BEARISH")score--;
  const direction=volatilityRatio>1.8?"UNCERTAIN":score>=3?"UP":score<=-3?"DOWN":"UNCERTAIN";
  return {direction,score,rsi:+rsi.toFixed(1),atr,volatilityRatio:+volatilityRatio.toFixed(2),notes,horizon:"Next 5 minutes",label:"Directional bias only — not a calibrated probability"};
}
function strategyVotes(rows,e9,e21,patterns,structure,rejectDirection) {
  const close=+rows.at(-1).close, prev=rows.at(-2), recent=rows.slice(-12,-2);
  const resistance=Math.max(...recent.map(c=>+c.high)), support=Math.min(...recent.map(c=>+c.low));
  const trend=e9.at(-1)>e21.at(-1)?"CALL":e9.at(-1)<e21.at(-1)?"PUT":null;
  const pullback=trend&&rejectDirection===trend&&((trend==="CALL"&&close>=e9.at(-1))||(trend==="PUT"&&close<=e9.at(-1)))?trend:null;
  const structureVote=structure.bias==="BULLISH"?"CALL":structure.bias==="BEARISH"?"PUT":null;
  const reversal=patterns.bottom?"CALL":patterns.top?"PUT":null;
  const breakoutRetest=(close>resistance&&+prev.low<=resistance)?"CALL":(close<support&&+prev.high>=support)?"PUT":null;
  const votes={trendPullback:pullback,structure:structureVote,reversal:reversal||rejectDirection,breakoutRetest};
  const tally={CALL:Object.values(votes).filter(x=>x==="CALL").length,PUT:Object.values(votes).filter(x=>x==="PUT").length};
  const balanced=tally.CALL>=2&&tally.CALL>tally.PUT?"CALL SETUP":tally.PUT>=2&&tally.PUT>tally.CALL?"PUT SETUP":"NO TRADE";
  return {votes,tally,balanced,support,resistance};
}

function evaluateCandles(rawRows, pair, interval) {
  const ordered = rawRows.slice().reverse();
  const rows = ordered.length > 35 ? ordered.slice(0, -1) : ordered;
  if (rows.length < 35) throw new Error("Not enough completed candles returned.");
  const closes=rows.map(c=>+c.close),highs=rows.map(c=>+c.high),lows=rows.map(c=>+c.low);
  const e9=emaSeries(closes,9),e21=emaSeries(closes,21),last=rows.at(-1);
  const patterns=findPattern(pivots(highs,"high"),pivots(lows,"low"),closes);
  let cross=null;
  for(let i=Math.max(1,rows.length-3);i<rows.length;i++){
    if(e9[i-1]<=e21[i-1]&&e9[i]>e21[i])cross="CALL";
    if(e9[i-1]>=e21[i-1]&&e9[i]<e21[i])cross="PUT";
  }
  const trend=e9.at(-1)>e21.at(-1)?"Bullish":e9.at(-1)<e21.at(-1)?"Bearish":"Flat";
  const rejectCall=candleReject(last,"CALL"),rejectPut=candleReject(last,"PUT");
  const rejectDirection=rejectCall?"CALL":rejectPut?"PUT":null;
  const patternDirection=patterns.bottom?"CALL":patterns.top?"PUT":null;
  const allCall=cross==="CALL"&&patternDirection==="CALL"&&rejectDirection==="CALL";
  const allPut=cross==="PUT"&&patternDirection==="PUT"&&rejectDirection==="PUT";
  const strictSignal=allCall?"CALL SETUP":allPut?"PUT SETUP":"NO TRADE";
  const structure=marketStructure(rows,highs,lows);
  const balanced=strategyVotes(rows,e9,e21,patterns,structure,rejectDirection);
  const predictor=predictor5m(rows,e9,e21,structure);
  const signal=scanMode==="BALANCED"?balanced.balanced:strictSignal;
  const expiry=calculateExpiry(rows,e9,e21,last,signal);
  return {pair,interval,rows,e9,e21,last,ema9:e9.at(-1),ema21:e21.at(-1),trend,cross,patterns,patternDirection,rejectDirection,signal,strictSignal,structure,balanced,predictor,choch:structure.event,expiry,
    reason:signal!=="NO TRADE"?(scanMode==="BALANCED"?`BALANCED mode: ${Math.max(balanced.tally.CALL,balanced.tally.PUT)} strategy checks agree. Paper-test; this mode may produce more false signals.`:"All three original strict conditions agree. Paper-test and independently verify."):
      (scanMode==="BALANCED"?"BALANCED mode: fewer than two strategy groups agree in one direction.":"STRICT mode: all three original conditions must agree. Missing: "+[!cross?"fresh EMA crossover":null,!patternDirection?"confirmed double pattern":null,!rejectDirection?"directional rejection":null].filter(Boolean).join(", "))};
}
function drawChart(rows, e9, e21) {
  const canvas = $("priceChart"); if (!canvas || !rows.length) return;
  const ctx = canvas.getContext("2d"), rect = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width*dpr)); canvas.height = Math.max(1, Math.floor(rect.height*dpr));
  ctx.setTransform(dpr,0,0,dpr,0,0);
  const W=rect.width,H=rect.height,pad={l:9,r:62,t:14,b:22},n=Math.min(rows.length,70),start=rows.length-n;
  const data=rows.slice(start),v9=e9.slice(start),v21=e21.slice(start);
  let vals=[]; data.forEach((c,i)=>vals.push(+c.high,+c.low,v9[i],v21[i])); vals=vals.filter(Number.isFinite);
  let min=Math.min(...vals),max=Math.max(...vals),extra=(max-min)*.08||.0001; min-=extra;max+=extra;
  const x=i=>pad.l+(i+.5)*(W-pad.l-pad.r)/n, y=v=>pad.t+(max-v)*(H-pad.t-pad.b)/(max-min),step=(W-pad.l-pad.r)/n;
  ctx.clearRect(0,0,W,H);ctx.font="10px system-ui";ctx.strokeStyle="#24364c";ctx.fillStyle="#91a4bd";ctx.lineWidth=1;
  for(let k=0;k<5;k++){const yy=pad.t+k*(H-pad.t-pad.b)/4;ctx.beginPath();ctx.moveTo(pad.l,yy);ctx.lineTo(W-pad.r,yy);ctx.stroke();ctx.fillText((max-k*(max-min)/4).toFixed(5),W-pad.r+5,yy+3);}
  data.forEach((c,i)=>{const o=+c.open,h=+c.high,l=+c.low,cl=+c.close,xx=x(i),up=cl>=o;ctx.strokeStyle=up?"#40d6a0":"#ff687c";ctx.fillStyle=ctx.strokeStyle;ctx.lineWidth=1.2;ctx.beginPath();ctx.moveTo(xx,y(h));ctx.lineTo(xx,y(l));ctx.stroke();const top=y(Math.max(o,cl)),bh=Math.max(1,Math.abs(y(o)-y(cl)));ctx.fillRect(xx-Math.max(1,step*.28),top,Math.max(2,step*.56),bh);});
  function line(a,color){ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=1.8;let begun=false;a.forEach((v,i)=>{if(!Number.isFinite(v))return;if(!begun){ctx.moveTo(x(i),y(v));begun=true;}else ctx.lineTo(x(i),y(v));});ctx.stroke();}
  line(v9,"#f3c969");line(v21,"#69a9ff");chartRange={data,x,y,pad,W,H,n,start,min,max};
}
function journal() {
  const a=JSON.parse(localStorage.getItem("simbotJournal")||"[]");
  $("count").textContent=a.length;$("winrate").textContent=a.length?(100*a.filter(x=>x==="win").length/a.length).toFixed(1)+"%":"—";
}
function getSignalHistory(){try{return JSON.parse(localStorage.getItem(HISTORY_KEY)||"[]");}catch{return [];}}
function saveSignalHistory(a){localStorage.setItem(HISTORY_KEY,JSON.stringify(a.slice(0,HISTORY_LIMIT)));}
function renderSignalHistory(){
  const body=$("signalHistory"), items=getSignalHistory();
  if(!items.length){body.innerHTML='<tr><td colspan="6">No confirmed signals recorded yet.</td></tr>';return;}
  body.innerHTML=items.map(x=>`<tr><td>${escapeHtml(x.detectedAt)}</td><td>${escapeHtml(x.pair)}</td><td class="${x.direction.toLowerCase()}">${escapeHtml(x.direction)}</td><td>${x.expiry} min</td><td>${x.score===null?"—":x.score+"/100"}</td><td>${escapeHtml(x.candleTime)}</td></tr>`).join("");
}
function escapeHtml(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function recordSignal(r){
  if(!r || r.signal==="NO TRADE" || !r.expiry.minutes)return;
  const direction=r.signal.startsWith("CALL")?"CALL":"PUT";
  const candleId=String(r.last.datetime||r.last.date||r.last.time||r.last.close);
  const key=[r.pair,direction,candleId].join("|");
  const a=getSignalHistory(); if(a.some(x=>x.key===key))return;
  a.unshift({key,pair:r.pair,direction,detectedAt:new Date().toLocaleString(),expiry:r.expiry.minutes,score:r.expiry.score,candleTime:candleTime(r.last)});
  saveSignalHistory(a);renderSignalHistory();
}
function renderPair(pair) {
  const r=results[pair];if(!r)return;
  $("pairTitle").textContent=pair;$("chartLabel").textContent=pair+" candlestick chart";
  $("signal").textContent=r.signal;$("reason").textContent=r.reason;
  $("ema9").textContent=fmt(r.ema9);$("ema21").textContent=fmt(r.ema21);$("trend").textContent=r.trend;
  $("crossCheck").textContent=r.cross||"No fresh crossover";
  $("patternCheck").textContent=r.patternDirection==="CALL"?"Confirmed double bottom":r.patternDirection==="PUT"?"Confirmed double top":"No confirmed breakout pattern";
  $("rejectCheck").textContent=r.rejectDirection?r.rejectDirection+" rejection":"No qualifying rejection";
  $("doubleTop").textContent=r.patterns.top?"Confirmed breakout":"Not confirmed";
  $("doubleBottom").textContent=r.patterns.bottom?"Confirmed breakout":"Not confirmed";
  $("rejection").textContent=r.rejectDirection||"Not detected";$("choch").textContent=r.choch;
  if($("structureValue"))$("structureValue").textContent=r.structure.structure+" · "+r.structure.event;
  if($("liquidityValue"))$("liquidityValue").textContent=r.structure.sweep;
  if($("orderBlockValue"))$("orderBlockValue").textContent=r.structure.orderBlock;
  if($("predictorValue"))$("predictorValue").textContent=r.predictor.direction+" · score "+r.predictor.score+"/5";
  if($("predictorDetail"))$("predictorDetail").textContent="RSI "+r.predictor.rsi+" · ATR "+fmt(r.predictor.atr)+" · volatility ratio "+r.predictor.volatilityRatio+" · "+r.predictor.label;
  if($("balancedValue"))$("balancedValue").textContent=r.balanced.balanced+" · CALL "+r.balanced.tally.CALL+" / PUT "+r.balanced.tally.PUT;
  if($("modeStatus"))$("modeStatus").textContent=scanMode+" mode active";
  $("patternDetail").textContent=r.patterns.top?"Double top neckline broken downward.":r.patterns.bottom?"Double bottom neckline broken upward.":"A pattern is only confirmed after two similar swing points and a neckline breakout.";
  $("expiryRecommendation").textContent=r.expiry.minutes?`Suggested ${r.expiry.minutes}-minute expiry`:"No expiry suggested";
  $("expiryReason").textContent=r.expiry.reason;
  $("expiryValue").textContent=r.expiry.minutes?`${r.expiry.minutes} min`:"—";
  $("confidenceValue").textContent=r.expiry.score===null?"—":`${r.expiry.score}/100`;
  $("signalCandleTime").textContent=candleTime(r.last);
  chartRows=r.rows;chartE9=r.e9;chartE21=r.e21;drawChart(chartRows,chartE9,chartE21);
  $("connection").textContent="Data loaded · "+Object.keys(results).length+" pairs scanned";
}
function renderScanner(){
  $("pairScanner").innerHTML=visiblePairs.map(pair=>{
    const r=results[pair],label=r?(r.error?"DATA ERROR":r.signal):"Not scanned";
    const cls=r&&r.signal!=="NO TRADE"&&!r.error?"scanner-card confirmed":"scanner-card";
    return `<article class="${cls}"><strong>${pair}</strong><span>${label}</span><button type="button" class="scan-pair" data-scan-pair="${pair}" ${busyPairs.has(pair)?"disabled":""}>${busyPairs.has(pair)?"Scanning…":"Scan this pair"}</button></article>`;
  }).join("");
  $("pairScanner").querySelectorAll("[data-scan-pair]").forEach(b=>b.addEventListener("click",async ev=>{ev.stopPropagation();await scanSingle(b.dataset.scanPair);}));
  $("pairScanner").querySelectorAll("article").forEach(card=>card.addEventListener("click",ev=>{
    if(ev.target.closest("button"))return;
    const pair=card.querySelector("[data-scan-pair]").dataset.scanPair;activePair=pair;$("pairSelect").value=pair;if(results[pair]&&!results[pair].error)renderPair(pair);
  }));
}
function getLastAlertState(){try{return JSON.parse(localStorage.getItem("simbotLastAlertState")||"{}");}catch{return {};}}
function setLastAlertState(state){localStorage.setItem("simbotLastAlertState",JSON.stringify(state));}
function getAudio(){const AudioCtx=window.AudioContext||window.webkitAudioContext;if(!AudioCtx)return null;if(!audioContext)audioContext=new AudioCtx();if(audioContext.state==="suspended")audioContext.resume();return audioContext;}
function playTone(){const ctx=getAudio();if(!ctx)return;const osc=ctx.createOscillator(),gain=ctx.createGain();osc.type="sine";osc.frequency.setValueAtTime(880,ctx.currentTime);gain.gain.setValueAtTime(.0001,ctx.currentTime);gain.gain.exponentialRampToValueAtTime(.24,ctx.currentTime+.025);gain.gain.exponentialRampToValueAtTime(.0001,ctx.currentTime+.42);osc.connect(gain);gain.connect(ctx.destination);osc.start();osc.stop(ctx.currentTime+.44);if(navigator.vibrate)navigator.vibrate([350,120,350]);}
function stopAlert(){if(alertTimer)clearInterval(alertTimer);alertTimer=null;if(navigator.vibrate)navigator.vibrate(0);$("alertStop").hidden=true;$("alertStatus").textContent=$("alertToggle").dataset.enabled==="true"?"Alerts are on. Waiting for a confirmed setup.":"Alerts are off.";}
function startAlert(pair,signal){stopAlert();$("alertStop").hidden=false;$("alertStatus").textContent="CONFIRMED: "+pair+" · "+signal+" — alert active";playTone();alertTimer=setInterval(playTone,1100);const title="SIMBOT confirmed setup",body=pair+" · "+signal+". "+(scanMode==="STRICT"?"Original strict confirmations agree.":"Balanced mode: at least two strategy groups agree.");if(serviceWorkerRegistration&&Notification.permission==="granted")serviceWorkerRegistration.showNotification(title,{body,tag:"simbot-"+pair.replace("/","-"),renotify:false});else if("Notification"in window&&Notification.permission==="granted")new Notification(title,{body});}
function processAlert(r){const enabled=$("alertToggle").dataset.enabled==="true",state=getLastAlertState(),signal=r.signal==="NO TRADE"?null:r.signal;if(!signal){delete state[r.pair];setLastAlertState(state);return;}if(!enabled||state[r.pair]===signal)return;state[r.pair]=signal;setLastAlertState(state);startAlert(r.pair,signal);}
async function enableAlerts(){if(!("Notification"in window)){$("alertStatus").textContent="This browser does not support notifications. Sound can still be tested.";}else{const permission=await Notification.requestPermission();if(permission!=="granted")$("alertStatus").textContent="Notification permission was not granted. You can still use sound while SIMBOT is open.";else $("alertStatus").textContent="Alerts enabled. Keep SIMBOT open and scanning.";}getAudio();}
async function scanOne(pair,interval){const response=await fetch(`/api/candles?symbol=${encodeURIComponent(pair)}&interval=${encodeURIComponent(interval)}`);const data=await response.json();if(!response.ok||data.status==="error")throw new Error(data.message||data.error||"Market data unavailable");return evaluateCandles(data.values||[],pair,interval);}
async function scanSingle(pair){
  if(busyPairs.has(pair)||scanAllBusy)return;
  busyPairs.add(pair);visiblePairs=[pair,...visiblePairs.filter(x=>x!==pair)].slice(0,8);renderScanner();
  const interval=$("interval").value;
  try{const r=await scanOne(pair,interval);results[pair]=r;recordSignal(r);processAlert(r);activePair=pair;$("pairSelect").value=pair;renderPair(pair);}
  catch(e){results[pair]={pair,error:e.message,signal:"DATA ERROR"};if(activePair===pair){$("signal").textContent="NO DATA";$("reason").textContent=pair+": "+e.message;}}
  finally{busyPairs.delete(pair);renderScanner();}
}
async function scanAll(){
  if(scanAllBusy)return;
  scanAllBusy=true;$("refresh").disabled=true;$("scanSelected").disabled=true;
  $("refresh").textContent="Scanning next 4…";$("connection").textContent="Scanning next batch of real forex pairs…";
  const interval=$("interval").value;
  const batch=[];for(let i=0;i<Math.min(4,PAIRS.length);i++){batch.push(PAIRS[(pairCursor+i)%PAIRS.length]);}pairCursor=(pairCursor+batch.length)%PAIRS.length;visiblePairs=[...batch];
  for(const pair of batch){
    busyPairs.add(pair);renderScanner();
    try{const r=await scanOne(pair,interval);results[pair]=r;recordSignal(r);processAlert(r);}
    catch(e){results[pair]={pair,error:e.message,signal:"DATA ERROR"};}
    finally{busyPairs.delete(pair);}
    renderScanner();
    if(pair===activePair){if(results[pair].error){$("signal").textContent="NO DATA";$("reason").textContent=pair+": "+results[pair].error;}else renderPair(pair);}
  }
  scanAllBusy=false;$("refresh").disabled=false;$("scanSelected").disabled=false;
  $("refresh").textContent="Scan next 4 pairs";
  $("connection").textContent="Batch complete · "+batch.length+" pairs checked · "+PAIRS.length+" pairs in catalogue";
  renderScanner();
}
$("refresh").addEventListener("click",scanAll);
$("scanSelected").addEventListener("click",()=>scanSingle(activePair));
$("interval").addEventListener("change",scanAll);
$("pairSelect").addEventListener("change",e=>{activePair=e.target.value;if(results[activePair]&&!results[activePair].error)renderPair(activePair);else scanSingle(activePair);});
$("alertToggle").addEventListener("click",async()=>{const enabled=$("alertToggle").dataset.enabled!=="true";$("alertToggle").dataset.enabled=String(enabled);$("alertToggle").textContent=enabled?"🔔 Alerts ON":"🔕 Alerts OFF";$("alertToggle").classList.toggle("active",enabled);if(enabled)await enableAlerts();else{stopAlert();$("alertStatus").textContent="Alerts are off.";};});
$("testSound").addEventListener("click",()=>{stopAlert();playTone();setTimeout(playTone,550);setTimeout(playTone,1100);$("alertStatus").textContent="Test sound played. Check your phone volume.";});
$("alertStop").addEventListener("click",stopAlert);
document.querySelectorAll("[data-result]").forEach(b=>b.addEventListener("click",()=>{const a=JSON.parse(localStorage.getItem("simbotJournal")||"[]");a.push(b.dataset.result);localStorage.setItem("simbotJournal",JSON.stringify(a));journal();}));
$("clear").addEventListener("click",()=>{localStorage.removeItem("simbotJournal");journal();});
$("clearSignalHistory").addEventListener("click",()=>{if(confirm("Clear all saved signal history on this device?")){localStorage.removeItem(HISTORY_KEY);renderSignalHistory();}});
$("priceChart").addEventListener("pointermove",ev=>{if(!chartRange)return;const rect=ev.currentTarget.getBoundingClientRect(),px=ev.clientX-rect.left,r=chartRange,idx=Math.max(0,Math.min(r.n-1,Math.floor((px-r.pad.l)/(r.W-r.pad.l-r.pad.r)*r.n))),c=r.data[idx];$("chartTip").textContent=`${c.datetime||"Candle"} · O ${fmt(+c.open)} H ${fmt(+c.high)} L ${fmt(+c.low)} C ${fmt(+c.close)} · EMA9 ${fmt(chartE9[r.start+idx])} · EMA21 ${fmt(chartE21[r.start+idx])}`;});
$("priceChart").addEventListener("pointerleave",()=>{$("chartTip").textContent="Move over chart to inspect candle";});
window.addEventListener("resize",()=>{if(chartRows.length)drawChart(chartRows,chartE9,chartE21);});
if("serviceWorker"in navigator)navigator.serviceWorker.register("/sw.js").then(reg=>{serviceWorkerRegistration=reg;}).catch(()=>{});
fetch("/api/status").then(r=>r.json()).then(d=>{if(!d.configured)$("connection").textContent="API key needed";}).catch(()=>{$("connection").textContent="Server not connected";});
async function loadForexPairs(){
  try{
    const res=await fetch("/api/forex-pairs");const data=await res.json();
    if(res.ok&&Array.isArray(data.pairs)&&data.pairs.length){PAIRS=[...new Set([...DEFAULT_PAIRS,...data.pairs])];visiblePairs=[...DEFAULT_PAIRS];
      const select=$("pairSelect"),current=select.value;select.innerHTML=PAIRS.map(p=>`<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("");select.value=PAIRS.includes(current)?current:PAIRS[0];
      $("pairCount").textContent=PAIRS.length+" pairs in Twelve Data catalogue";
    }else throw new Error(data.error||"Pair catalogue unavailable");
  }catch(e){PAIRS=[...DEFAULT_PAIRS];if($("pairCount"))$("pairCount").textContent="Default pairs only · catalogue unavailable";}
  renderScanner();await scanAll();
}
if($("strategyMode"))$("strategyMode").addEventListener("change",e=>{scanMode=e.target.value;for(const pair of Object.keys(results)){if(results[pair]&&!results[pair].error)results[pair]=evaluateCandles(results[pair].rows.slice().reverse(),pair,results[pair].interval);}if(results[activePair])renderPair(activePair);renderScanner();});
journal();renderSignalHistory();renderScanner();loadForexPairs();

const autoScanStatus=document.createElement("div");
autoScanStatus.id="autoScanStatus";autoScanStatus.textContent="Auto scan: ON · rotates through 4 pairs each minute";
$("connection").insertAdjacentElement("afterend",autoScanStatus);
let autoScanLastTime=null;
setInterval(()=>{
  if(document.hidden){autoScanStatus.textContent="Auto scan: ON · paused while page is hidden";return;}
  if(scanAllBusy||busyPairs.size){autoScanStatus.textContent="Auto scan: ON · waiting for current scan to finish";return;}
  autoScanStatus.textContent="Auto scan: scanning next 4 pairs…";
  scanAll().then(()=>{autoScanLastTime=new Date();autoScanStatus.textContent="Auto scan: ON · last scan "+autoScanLastTime.toLocaleTimeString();})
    .catch(()=>{autoScanStatus.textContent="Auto scan: ON · scan error; will retry in 1 minute";});
},60000);
