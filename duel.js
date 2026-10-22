"use strict";
// ==================== 共用核心 ====================
// 牌局邏輯（抽牌/洗牌/手牌評分/勝率）抽到 multiplayer/game-core.js，
// 訓練模式與多人版共用同一份，避免邏輯分叉。
const PC = window.PokerCore;
const SUITC = PC.SUITC;
const RANKC = PC.RANKC;
const STREETN = PC.STREETN;
const CATN = PC.CATN;
const deckAll = PC.deckAll;
const shuffle = PC.shuffle;
const cardKey = PC.cardKey;
const cardStr = PC.cardStr;
const cardRed = PC.cardRed;
const drawUnseen = PC.drawUnseen;
const evaluate5 = PC.evaluate5;
const cmpScores = PC.cmpScores;
const evaluate7 = PC.evaluate7;
const catName = PC.catName;
const estimate = PC.estimate;
const unseen = PC.unseen;

// ==================== 遊戲狀態 ====================
const BI=10; // 小盲
const BB=20; // 大盲
const G={
  heroChips:1000, aiChips:1000, pot:30,
  board:[], hx:[], ax:[],
  street:0,
  heroIn:10, aiIn:20,   // 本街已投入
  currentBet:20,        // 本街最高下注
  heroNeed:0, aiNeed:0, // 雙方目前需再投入
  toAct:null, ended:false, winner:null, resultText:'',
  review:[], lastAi:'', hintEq:0, hintNeed:0,
  heroStreet:10, aiStreet:20, raiseCount:0,
  toActOrder:null,
};
function drawCommunity(){
  const used=new Set(G.board.map(cardKey));
  const rem=deckAll().filter(c=>!used.has(cardKey(c)));
  return shuffle(rem)[0];
}
function communityAll(){ while(G.board.length<5)G.board.push(drawCommunity()); }
function newRound(){
  const d=shuffle(deckAll());
  G.hx=[d.pop(),d.pop()]; G.ax=[d.pop(),d.pop()];
  G.board=[]; G.street=0;
  G.heroChips=1000; G.aiChips=1000; G.pot=30;
  G.heroIn=10; G.aiIn=20; G.currentBet=20; G.heroNeed=10; G.aiNeed=0;
  G.toAct='hero'; G.ended=false; G.winner=null; G.resultText='';
  G.review=[]; G.lastAi=''; G.raiseCount=0;
  render();
}
function advance(){
  // 一街行動結束，前進
  if(G.ended)return;
  if(G.street<3){
    G.street++;
    const n=G.street===1?3:1;
    for(let i=0;i<n;i++)G.board.push(drawCommunity());
    G.heroIn=0; G.aiIn=0; G.currentBet=0; G.heroNeed=0; G.aiNeed=0;
    G.toAct='hero';
    aiFirst();
    render();
  }else{
    showdown();
  }
}
function aiFirst(){
  // 翻牌後 AI 先行動：強或聽牌則下注，否則過牌
  if(G.ended)return;
  const sc=evaluate7(G.ax.concat(G.board));
  const {outs,eq}=aiInsight();
  const strong = sc[0]>=1 || eq>=50;
  const pot = G.pot;
  if(strong){
    const bet = Math.max(20, Math.round(pot*0.5));
    const amt = Math.min(bet, G.aiChips);
    G.aiChips-=amt; G.pot+=amt; G.aiIn+=amt;
    G.currentBet=Math.max(G.currentBet,G.aiIn);
    G.heroNeed=Math.max(0, G.currentBet-G.heroIn);
    G.toAct='hero';
    G.lastAi = `AI 下注 ${amt}`;
  }else{
    G.currentBet=0; G.heroNeed=0; G.aiNeed=0;
    G.toAct='hero';
    G.lastAi='AI 過牌';
  }
  render();
}
function aiDecide(){
  // AI 回應 hero 的行動（加注 / 全下）
  if(G.ended)return;
  const sc=evaluate7(G.ax.concat(G.board));
  const e=estimate(G.ax,G.hx,G.board);
  const aeq=(e.win+e.tie/2)/e.n*100;
  const aiNeed=Math.max(0, G.currentBet-G.aiIn);
  const needPct = aiNeed>0 ? aiNeed/(G.pot+aiNeed)*100 : 0;
  const strong = sc[0]>=1;
  const draws = aiOuts()>=8;
  const heroAllIn = G.heroChips<=0;
  // 反加注：強牌且還沒太多次時，50% 反加注（hero 未全下才反加）
  if(!heroAllIn && G.raiseCount<2 && (sc[0]>=2 || (sc[0]===1 && aeq>=55)) && Math.random()<0.5){
    let t=Math.round(G.currentBet*2.2);
    const cap=G.aiIn+G.aiChips; if(t>cap)t=cap;
    G.aiChips-=(t-G.aiIn); G.pot+=(t-G.aiIn); G.aiIn=t;
    G.currentBet=t; G.raiseCount++;
    G.lastAi='AI 反加注至 '+t+'（牌強）';
    G.toAct='hero'; G.heroNeed=Math.max(0, G.currentBet-G.heroIn);
    render(); return;
  }
  const calls = aeq>=needPct || strong || draws;
  if(calls){
    const amt=Math.min(aiNeed, G.aiChips);
    G.aiChips-=amt; G.pot+=amt; G.aiIn+=amt;
    G.lastAi= aiNeed>0 ? ('AI 跟注 '+amt) : 'AI 過牌';
    if(heroAllIn || G.aiChips<=0){ showdown(); }
    else if(G.heroIn===G.aiIn && G.heroIn>=G.currentBet){ advance(); }
    else { G.toAct='hero'; G.heroNeed=Math.max(0,G.currentBet-G.heroIn); render(); }
    return;
  }
  // 蓋牌
  G.ended=true; G.winner='hero';
  G.resultText='AI 蓋牌，你贏得底池';
  G.review.push({street:STREETN[G.street],text:'AI 蓋牌（勝率不足）',ok:true});
  render();
}
function aiOuts(){
  // 粗估：同花聽牌(4同色)、順子聽牌
  const cs=G.ax.concat(G.board);
  const suits={};cs.forEach(c=>suits[c.s]=(suits[c.s]||0)+1);
  const mx=Math.max(...Object.values(suits),0);
  let outs=0;
  if(mx>=4) outs=Math.max(outs,9);
  return outs;
}
function aiInsight(){
  const e=estimate(G.ax,G.hx,G.board);
  const eq=(e.win+e.tie/2)/e.n*100;
  return {outs:aiOuts(), eq};
}
function pushReview(text){
  pushReviewEntry(text, true);
}
function pushReviewEntry(text, verdict){
  G.review.push({street:STREETN[G.street], text, ok:verdict});
}
function heroFold(){
  if(G.ended||G.toAct!=='hero')return;
  G.ended=true; G.winner='ai'; G.resultText='你棄牌，AI 拿下底池';
  G.lastAi='';
  pushReview('你棄牌（合理?）');
  render();
}
function heroCall(){
  if(G.ended||G.toAct!=='hero')return;
  const amt=Math.min(G.heroNeed, G.heroChips);
  G.heroChips-=amt; G.pot+=amt; G.heroIn+=amt; G.heroNeed=0;
  if(G.heroChips<=0||G.aiChips<=0){ showdown(); return; }
  if(G.heroIn>=G.currentBet && G.aiIn>=G.currentBet && G.heroNeed<=0){ advance(); }
  else if(G.heroIn>=G.currentBet){ G.toAct='hero'; render(); }
  else { G.aiNeed=G.currentBet-G.aiIn; render(); }
}
function heroRaiseTo(target){
  if(G.ended||G.toAct!=='hero')return;
  let t=Math.round(target);
  const minTotal=G.currentBet+Math.max(BB, G.currentBet);
  if(t<minTotal) t=minTotal;
  const cap=G.heroIn+G.heroChips;
  if(t>cap) t=cap;
  const amt=t-G.heroIn;
  if(amt<=0) return;
  G.heroChips-=amt; G.pot+=amt; G.heroIn=t; G.heroNeed=0;
  G.currentBet=Math.max(G.currentBet,t);
  G.raiseCount++;
  pushReview('你加注至 '+t);
  aiDecide();
}
function heroAllIn(){
  if(G.ended||G.toAct!=='hero')return;
  const amt=G.heroChips;
  G.heroChips=0; G.pot+=amt; G.heroIn+=amt; G.currentBet=Math.max(G.currentBet,G.heroIn);
  pushReview('你全下 '+amt);
  aiDecide();
}
function showdown(){
  if(G.ended)return;
  G.street=4;
  communityAll();
  const hs=evaluate7(G.hx.concat(G.board));
  const as=evaluate7(G.ax.concat(G.board));
  const d=cmpScores(hs,as);
  let who, why;
  if(d>0){who='hero'; why='攤牌：你的 '+catName(hs)+' 勝 '+catName(as);}
  else if(d<0){who='ai'; why='攤牌：AI 的 '+catName(as)+' 勝你的 '+catName(hs);}
  else {who='tie'; why='攤牌：平手 '+catName(hs);}
  G.winner=who;
  G.ended=true;
  if(who==='hero'){G.heroChips+=G.pot; G.resultText='你贏！'+why;}
  else if(who==='ai'){G.aiChips+=G.pot; G.resultText='AI 贏：'+why;}
  else {G.heroChips+=G.pot/2; G.aiChips+=G.pot/2; G.resultText='平手：'+why;}
  render();
}
function hint(){
  const e=estimate(G.hx,G.ax,G.board);
  const eq=(e.win+e.tie/2)/e.n*100;
  G.hintEq=eq;
  G.hintNeed = G.heroNeed>0 ? G.heroNeed/(G.heroNeed+G.pot)*100 : 0;
}
// ==================== 渲染 ====================
function $(id){return document.getElementById(id);}
function render(){
  $('heroch').textContent=G.heroChips;
  $('aich').textContent=G.aiChips;
  $('potcho').textContent=G.pot;
  $('potv').textContent=G.pot;
  $('streetlab').textContent = G.street>3? (G.winner==='hero'?'你贏':'AI 贏') : STREETN[G.street];
  // AI 手牌
  const aih=$('aiboard');
  if(G.ended){ aih.innerHTML = G.ax.map(c=>cardEl(c,true)).join(''); }
  else { aih.innerHTML = '<div class="pcard down">?</div><div class="pcard down">?</div>'; }
  // 公用牌
  $('comboard').innerHTML = G.board.map(c=>cardEl(c,false)).join('') || '<span class="mark">等待發牌</span>';
  // 英雄手牌
  $('herob').innerHTML = G.hx.map(c=>cardEl(c,false)).join('');
  // 提示
  hint();
  let h='';
  h += `你的勝率(估)：約 <b>${G.hintEq.toFixed(0)}%</b>`;
  if(G.heroNeed>0){
    const need=G.hintNeed.toFixed(0);
    h += ` · 需再投入 <b>${G.heroNeed}</b>`;
    h += `<br>所需勝率門檻 = ${G.heroNeed} ÷ (${G.pot}+${G.heroNeed}) = <b>${need}%</b>`;
    h += `<br>${G.hintEq>=G.hintNeed ? '<span class="ok">'+(G.hintEq>=G.hintNeed?'跟注在數學上 +EV':'跟注偏貴')+'</span>' : '<span class="no">勝率不足，傾向棄牌</span>'}`;
  }
  $('hintbox').innerHTML = `<div class="hintbox">${h}</div>`;
  // 控制
  let c='';
  if(!G.ended && G.toAct==='hero'){
    c += `<button class="btn-fold" onclick="heroFold()">棄牌</button>`;
    c += `<button class="btn-call" onclick="heroCall()">${G.heroNeed>0?('跟注 '+G.heroNeed):'過牌'}</button>`;
    c += `<button class="btn-raise" onclick="showRaise()">加注</button>`;
    c += `<button class="btn-allin" onclick="heroAllIn()">全下</button>`;
  } else if(!G.ended){
    c = `<div class="wait">AI 思考中…</div>`;
  }
  $('controls').innerHTML=c;
  // AI 註記
  $('ailab').innerHTML = G.lastAi;
  // 回顧
  if(G.ended){
    let r=`<div class="post"><h3>決策檢討</h3>`;
    G.review.forEach(x=>{ r+=`<div class="rev"><span class="l">${x.street}</span><span class="${x.ok?'ok':'no'}">${x.text}</span></div>`; });
    r += `<div class="rev"><span class="l">結果</span><span>${G.resultText}</span></div>`;
    r += `<button class="bact" onclick="newRound()">再練一手</button>`;
    r += `<button class="bact" style="background:#334155" onclick="location.href='index.html'">回機率題庫</button>`;
    $('post').innerHTML=r;
  } else { $('post').innerHTML=''; }
}
function showRaise(){
  if(G.ended||G.toAct!=='hero')return;
  const minTotal=G.currentBet+Math.max(BB, G.currentBet);
  const opts=[
    [minTotal, '最小加注至 '+minTotal],
    [Math.round(minTotal*1.6), '加注至 '+Math.round(minTotal*1.6)],
    [G.heroIn+G.heroChips, '全下 '+G.heroChips],
  ];
  $('controls').innerHTML = opts.map(o=>`<button class="btn-raise" onclick="heroRaiseTo(${o[0]})">${o[1]}</button>`).join('')
    +`<button class="btn-call" onclick="render()">取消</button>`;
}
function cardEl(c){
  const suit=SUITC[c.s];
  const red=cardRed(c);
  return `<div class="pcard ${red?'red':''}">${RANKC[c.r-2]}<span class="suit">${suit}</span></div>`;
}
newRound();
