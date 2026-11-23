const $=id=>document.getElementById(id), fmt=n=>Number.isFinite(n)?n.toFixed(5):"—";
let chartRows=[], chartE9=[], chartE21=[], chartRange=null;
function emaSeries(a,p){let out=Array(a.length).fill(NaN);if(a.length<p)return out;let v=a.slice(0,p).reduce((x,y)=>x+y,0)/p;out[p-1]=v;let k=2/(p+1);for(let i=p;i<a.length;i++){v=a[i]*k+v*(1-k);out[i]=v;}return out;}
function pivots(a,type){let out=[];for(let i=2;i<a.length-2;i++){let v=a[i];if(type==="high"&&v>a[i-1]&&v>a[i-2]&&v>=a[i+1]&&v>=a[i+2])out.push({i,v});if(type==="low"&&v<a[i-1]&&v<a[i-2]&&v<=a[i+1]&&v<=a[i+2])out.push({i,v});}return out;}
function near(a,b){return Math.abs(a-b)/Math.max(Math.abs(a),Math.abs(b),1e-9)<=0.001;}
function findPattern(hs,ls,closes){
 const tops=hs.slice(-6), bottoms=ls.slice(-6);let top=null,bottom=null;
 if(tops.length>=2){let a=tops.at(-2),b=tops.at(-1);if(b.i-a.i>=5&&near(a.v,b.v)){let neckline=Math.min(...closes.slice(a.i,b.i+1));if(closes.at(-1)<neckline)top={a,b,neckline};}}
 if(bottoms.length>=2){let a=bottoms.at(-2),b=bottoms.at(-1);if(b.i-a.i>=5&&near(a.v,b.v)){let neckline=Math.max(...closes.slice(a.i,b.i+1));if(closes.at(-1)>neckline)bottom={a,b,neckline};}}
 return {top,bottom};
}
function candleReject(c,direction){let o=+c.open,h=+c.high,l=+c.low,cl=+c.close,body=Math.abs(cl-o),range=h-l;if(!(range>0))return false;let upper=h-Math.max(o,cl),lower=Math.min(o,cl)-l;let safeBody=Math.max(body,range*.05);return direction==="CALL"?(lower>=safeBody*2&&cl>o&&cl>=l+range*.6):(upper>=safeBody*2&&cl<o&&cl<=l+range*.4);}
function drawChart(rows,e9,e21){
 const canvas=$("priceChart"),ctx=canvas.getContext("2d"),rect=canvas.getBoundingClientRect(),dpr=window.devicePixelRatio||1;
 canvas.width=Math.max(1,Math.floor(rect.width*dpr));canvas.height=Math.max(1,Math.floor(rect.height*dpr));ctx.setTransform(dpr,0,0,dpr,0,0);
 const W=rect.width,H=rect.height,pad={l:9,r:58,t:14,b:22},n=Math.min(rows.length,70),start=rows.length-n,data=rows.slice(start),v9=e9.slice(start),v21=e21.slice(start);
 let vals=[];data.forEach((c,i)=>vals.push(+c.high,+c.low,v9[i],v21[i]));vals=vals.filter(Number.isFinite);let min=Math.min(...vals),max=Math.max(...vals),extra=(max-min)*.08||.0001;min-=extra;max+=extra;
 const x=i=>pad.l+(i+.5)*(W-pad.l-pad.r)/n,y=v=>pad.t+(max-v)*(H-pad.t-pad.b)/(max-min),step=(W-pad.l-pad.r)/n;
 ctx.clearRect(0,0,W,H);ctx.font="10px system-ui";ctx.strokeStyle="#24364c";ctx.fillStyle="#91a4bd";ctx.lineWidth=1;
 for(let k=0;k<5;k++){let yy=pad.t+k*(H-pad.t-pad.b)/4;ctx.beginPath();ctx.moveTo(pad.l,yy);ctx.lineTo(W-pad.r,yy);ctx.stroke();let price=max-k*(max-min)/4;ctx.fillText(price.toFixed(5),W-pad.r+5,yy+3);}
 data.forEach((c,i)=>{let o=+c.open,h=+c.high,l=+c.low,cl=+c.close,xx=x(i),up=cl>=o;ctx.strokeStyle=up?"#40d6a0":"#ff687c";ctx.fillStyle=ctx.strokeStyle;ctx.lineWidth=1.2;ctx.beginPath();ctx.moveTo(xx,y(h));ctx.lineTo(xx,y(l));ctx.stroke();let top=y(Math.max(o,cl)),bh=Math.max(1,Math.abs(y(o)-y(cl)));ctx.fillRect(xx-Math.max(1,step*.28),top,Math.max(2,step*.56),bh);});
 function line(a,color){ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=1.8;let begun=false;a.forEach((v,i)=>{if(!Number.isFinite(v))return;let xx=x(i),yy=y(v);if(!begun){ctx.moveTo(xx,yy);begun=true;}else ctx.lineTo(xx,yy);});ctx.stroke();}
 line(v9,"#f3c969");line(v21,"#69a9ff");
 chartRange={data,x,y,pad,W,H,n,start,min,max};
}
function journal(){let a=JSON.parse(localStorage.getItem("simbotJournal")||"[]");$("count").textContent=a.length;$("winrate").textContent=a.length?(100*a.filter(x=>x==="win").length/a.length).toFixed(1)+"%":"—";}
async function analyze(){
 $("signal").textContent="ANALYSING…";$("reason").textContent="Requesting market candles.";
 try{
  let interval=$("interval").value,r=await fetch(`/api/candles?symbol=EUR/USD&interval=${interval}`),d=await r.json();if(!r.ok)throw Error(d.error||"Market data unavailable");
  let rows=(d.values||[]).slice().reverse();if(rows.length<35)throw Error("Not enough candles returned.");
  let closes=rows.map(c=>+c.close),highs=rows.map(c=>+c.high),lows=rows.map(c=>+c.low),e9=emaSeries(closes,9),e21=emaSeries(closes,21),last=rows.at(-1);
  let hs=pivots(highs,"high"),ls=pivots(lows,"low"),patterns=findPattern(hs,ls,closes);
  // Crossover is a fresh cross within the last three completed data points, not merely EMA alignment.
  let cross=null;for(let i=Math.max(1,rows.length-3);i<rows.length;i++){if(e9[i-1]<=e21[i-1]&&e9[i]>e21[i])cross="CALL";if(e9[i-1]>=e21[i-1]&&e9[i]<e21[i])cross="PUT";}
  let trend=e9.at(-1)>e21.at(-1)?"Bullish":e9.at(-1)<e21.at(-1)?"Bearish":"Flat";
  let rejectCall=candleReject(last,"CALL"),rejectPut=candleReject(last,"PUT"),patternDirection=patterns.bottom?"CALL":patterns.top?"PUT":null;
  let rejectDirection=rejectCall?"CALL":rejectPut?"PUT":null;
  let allCall=cross==="CALL"&&patternDirection==="CALL"&&rejectDirection==="CALL",allPut=cross==="PUT"&&patternDirection==="PUT"&&rejectDirection==="PUT";
  let signal=allCall?"CALL SETUP":allPut?"PUT SETUP":"NO TRADE";
  $("ema9").textContent=fmt(e9.at(-1));$("ema21").textContent=fmt(e21.at(-1));$("trend").textContent=trend;
  $("crossCheck").textContent=cross||"No fresh crossover";$("patternCheck").textContent=patternDirection==="CALL"?"Confirmed double bottom":patternDirection==="PUT"?"Confirmed double top":"No confirmed breakout pattern";
  $("rejectCheck").textContent=rejectDirection?`${rejectDirection} rejection`:"No qualifying rejection";
  $("doubleTop").textContent=patterns.top?"Confirmed breakout":"Not confirmed";$("doubleBottom").textContent=patterns.bottom?"Confirmed breakout":"Not confirmed";
  $("rejection").textContent=rejectDirection||"Not detected";
  let recentHigh=Math.max(...highs.slice(-12,-2)),recentLow=Math.min(...lows.slice(-12,-2)),choch=+last.close>recentHigh?"Bullish break":+last.close<recentLow?"Bearish break":"Not detected";
  $("choch").textContent=choch;
  $("patternDetail").textContent=patterns.top?"Double top neckline broken downward.":patterns.bottom?"Double bottom neckline broken upward.":"A pattern is only confirmed after two similar swing points and a neckline breakout.";
  $("signal").textContent=signal;
  $("reason").textContent=allCall?"All three bullish conditions agree. Paper-test and independently verify.":allPut?"All three bearish conditions agree. Paper-test and independently verify.":"NO TRADE: all three conditions must agree in the same direction. Missing: "+[!cross?"fresh EMA crossover":null,!patternDirection?"confirmed double pattern":null,!rejectDirection?"directional rejection":null].filter(Boolean).join(", ")+".";
  $("connection").textContent=`Data loaded · ${rows.length} candles`;chartRows=rows;chartE9=e9;chartE21=e21;drawChart(rows,e9,e21);
 }catch(e){$("signal").textContent="NO DATA";$("reason").textContent=e.message;$("connection").textContent="Data unavailable";}
}
$("refresh").addEventListener("click",analyze);$("interval").addEventListener("change",analyze);
document.querySelectorAll("[data-result]").forEach(b=>b.addEventListener("click",()=>{let a=JSON.parse(localStorage.getItem("simbotJournal")||"[]");a.push(b.dataset.result);localStorage.setItem("simbotJournal",JSON.stringify(a));journal();}));
$("clear").addEventListener("click",()=>{localStorage.removeItem("simbotJournal");journal();});
$("priceChart").addEventListener("pointermove",ev=>{if(!chartRange)return;let rect=ev.currentTarget.getBoundingClientRect(),x=ev.clientX-rect.left,r=chartRange,idx=Math.max(0,Math.min(r.n-1,Math.floor((x-r.pad.l)/(r.W-r.pad.l-r.pad.r)*r.n))),c=r.data[idx];$("chartTip").textContent=`${c.datetime||"Candle"} · O ${fmt(+c.open)} H ${fmt(+c.high)} L ${fmt(+c.low)} C ${fmt(+c.close)} · EMA9 ${fmt(chartE9[r.start+idx])} · EMA21 ${fmt(chartE21[r.start+idx])}`;});
$("priceChart").addEventListener("pointerleave",()=>{$("chartTip").textContent="Move over chart to inspect candle";});
window.addEventListener("resize",()=>{if(chartRows.length)drawChart(chartRows,chartE9,chartE21);});
fetch("/api/status").then(r=>r.json()).then(d=>{if(!d.configured)$("connection").textContent="API key needed";}).catch(()=>{$("connection").textContent="Server not connected";});
journal();analyze();
