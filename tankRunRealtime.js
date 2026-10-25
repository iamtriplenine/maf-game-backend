// MAF_TANKRUN_ROOM_V1. Une simulation autoritaire par salon actif.
// MAF_TANKRUN_LAG_V1 : snapshots legers + compensation de latence du viseur.
// Important: mode multi-instance Render non supporte sans coordination externe.
import { Game } from './tankRunEngine.js';
const active = new Map();
const MAX_IDLE = 5 * 60 * 1000;
const HISTORY_SECONDS = 2.5;    // memoire des angles (pour revenir a ce que le joueur voyait)
const MAX_REWIND = 0.9;        // on ne remonte jamais plus de 0,9 s dans le passe (anti-triche)
const AIM_TOLERANCE = 0.05;    // rad (~3 deg) : ecart max entre l'angle annonce et un angle reellement atteint
const REORDER_WAIT = 150;      // ms d'attente d'une commande manquante avant de continuer

const TAU = Math.PI * 2;
const angDiff = (a, b) => {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU;
  return d;
};
const r1 = (v) => Math.round(v * 10) / 10;
const r3 = (v) => Math.round(v * 1000) / 1000;

function snapshot(g) {
  return {
    w:g.w,h:g.h, cfg:g.cfg,arena:g.arena || null,rects:g.rects,
    tanks:g.tanks,bullets:g.bullets,particles:g.particles,flashes:g.flashes,
    time:g.time,phase:g.phase,countdown:g.countdown,goTimer:g.goTimer,
    shake:g.shake,winner:g.winner,
  };
}

function tagBullets(x) {
  for (const b of x.g.bullets) if (b.id == null) b.id = ++x.bulletId;
}

// Version legere envoyee ~20 fois par seconde. Les donnees fixes (terrain, murs,
// configuration) ne sont envoyees que sur demande (full).
function liteSnapshot(x, full) {
  const g = x.g;
  tagBullets(x);
  const out = {
    lite: true,
    t: r3(g.time),
    phase: g.phase, countdown: r3(g.countdown), goTimer: r3(g.goTimer),
    shake: r3(g.shake), winner: g.winner,
    ack: x.inq.map((q) => q.next - 1),
    ackEpoch: x.inq.map((q) => q.epoch),
    tanks: g.tanks.map((t) => ({
      i: t.i, human: t.human, color: t.color, corner: t.corner, r: t.r, skin: t.skin, ammo: t.ammo,
      x: r1(t.x), y: r1(t.y), angle: r3(t.angle), dir: t.dir, hp: t.hp, alive: t.alive,
      pressed: t.pressed, heldFor: r3(t.heldFor), moving: t.moving,
      recoil: r3(t.recoil), hitFlash: r3(t.hitFlash), tread: r1(t.tread),
    })),
    bullets: g.bullets.map((b) => ({
      id: b.id, x: r1(b.x), y: r1(b.y), vx: r1(b.vx), vy: r1(b.vy),
      r: b.r, color: b.color, owner: b.owner, ammo: b.ammo,
    })),
    flashes: g.flashes.map((f) => ({ x: r1(f.x), y: r1(f.y), angle: r3(f.angle), life: r3(f.life), max: f.max })),
    particles: g.particles.slice(-140).map((p) => ({
      k: p.k, x: r1(p.x), y: r1(p.y), vx: r1(p.vx), vy: r1(p.vy), life: r3(p.life), max: r3(p.max),
      size: r1(p.size), color: p.color, rot: r3(p.rot), vr: r1(p.vr),
    })),
  };
  if (full) {
    out.w = g.w; out.h = g.h; out.cfg = g.cfg; out.arena = g.arena || null; out.rects = g.rects;
  }
  return out;
}

export function dropTankRunRuntime(id){
 const key=String(id);const x=active.get(key);
 if(x){
  clearInterval(x.timer);
  for(const q of x.inq) if(q.timer) clearTimeout(q.timer);
  active.delete(key);
 }
}
// Acces direct a une simulation deja active (sans toucher a la base de donnees).
export function peekTankRunRuntime(id){
 return active.get(String(id)) || null;
}
export function getTankRunRuntime(room,onResult,onCheckpoint){
 const key=String(room.id);let x=active.get(key);
 if(x)return x;
 if(!room.match_state||room.match_state.type!=='tankrun'||room.status!=='playing')throw new Error('Match non initialise');
 const g=new Game([{human:true},{human:true}],{
   arena: room.match_state.arena==='original'?undefined:room.match_state.arena,
   skins:(room.match_state.skins||[]).map(s=>s==='origine'?null:s),
   ammo:['standard','standard'],countdown:3,fireCooldown:0.085,maxBullets:24,holdThreshold:0.25,
 });
 const restored=room.match_state.runtime;
 if(restored && Array.isArray(restored.tanks) && restored.tanks.length===2 &&
    ['countdown','playing','ending'].includes(restored.phase)) Object.assign(g,restored);
 const newInq=()=>({epoch:null,next:1,pending:new Map(),timer:null});
 x={g,last:Date.now(),access:Date.now(),lastCheckpoint:Date.now(),inProgress:false,saving:false,timer:null,
   players:[room.host_id,room.guest_id],verifyAt:Date.now(),
   inq:[newInq(),newInq()],hist:[],lastAim:[null,null],
   bulletId:g.bullets.reduce((m,b)=>Math.max(m,b.id||0),0),
   snapshot:()=>{x.access=Date.now();return snapshot(g)},
   lite:(full)=>{x.access=Date.now();return liteSnapshot(x,full)}};
 g.onOver=winner=>{if(x.inProgress)return;x.inProgress=true;Promise.resolve(onResult(room.id,winner)).catch(e=>console.error('tankrun payout',e.message))};
 x.timer=setInterval(()=>{
  if(active.get(key)!==x)return;
  const now=Date.now();const diff=Math.min(200,now-x.last);x.last=now;
  if(now-x.access>MAX_IDLE){dropTankRunRuntime(key);return}
  const steps=Math.max(1,Math.min(12,Math.round(diff/(1000/60))));
  for(let i=0;i<steps;i++){
   if(g.phase==='over')break;
   g.update(diff/1000/steps);
   tagBullets(x);
   x.hist.push({t:g.time,a:[g.tanks[0].angle,g.tanks[1].angle]});
  }
  const oldest=g.time-HISTORY_SECONDS;
  let cut=0;while(cut<x.hist.length-1&&x.hist[cut].t<oldest)cut++;
  if(cut>0)x.hist.splice(0,cut);
  if(now-x.lastCheckpoint>=2000&&!x.saving&&g.phase!=='over'&&onCheckpoint){
    x.lastCheckpoint=now;x.saving=true;
    Promise.resolve(onCheckpoint(room.id,snapshot(g))).catch(e=>console.error('tankrun checkpoint',e.message)).finally(()=>{x.saving=false});
  }
 },1000/60);
 x.timer.unref?.();active.set(key,x);return x;
}

// Angle du char `index` tel qu'il etait a l'instant de simulation `vt`.
export function tankRunAngleAt(x,index,vt){
 const h=x.hist;
 if(!h.length)return null;
 const now=x.g.time;
 const t=Math.min(now,Math.max(now-MAX_REWIND,vt));
 if(t>=h[h.length-1].t)return h[h.length-1].a[index];
 if(t<=h[0].t)return h[0].a[index];
 for(let k=h.length-1;k>0;k--){
  const a=h[k-1],b=h[k];
  if(t>=a.t&&t<=b.t){
   const span=b.t-a.t;const f=span>1e-9?(t-a.t)/span:1;
   return a.a[index]+angDiff(a.a[index],b.a[index])*f;
  }
 }
 return h[h.length-1].a[index];
}

// Le char avait-il cet angle a l'instant que le joueur regardait (vt) ?
function matchesView(x,index,vt,aim){
 const h=x.hist;if(!h.length)return false;
 const now=x.g.time;
 const t=Math.min(now,Math.max(now-MAX_REWIND,vt));
 for(let k=h.length-1;k>=0;k--){
  if(h[k].t>t+0.08)continue;
  if(h[k].t<t-0.08)break;
  if(Math.abs(angDiff(h[k].a[index],aim))<=AIM_TOLERANCE)return true;
 }
 return false;
}

function applyEvent(x,index,ev){
 const t=x.g.tanks[index];
 if(ev.ammo&&t)t.ammo=ev.ammo;
 let aim;
 if(ev.down&&t){
  // L'angle annonce est utilise s'il correspond a ce que le char montrait a l'instant
  // regarde par le joueur, ou a son dernier angle confirme (appuis rapproches).
  // Sinon on se rabat sur l'angle reel du serveur a cet instant : impossible de viser
  // n'importe ou en trichant avec le client.
  const last=x.lastAim[index];
  const sameAsLast=last&&x.g.time-last.at<1.5&&Number.isFinite(ev.aim)&&Math.abs(angDiff(last.a,ev.aim))<=AIM_TOLERANCE;
  if(Number.isFinite(ev.aim)&&Number.isFinite(ev.vt)&&matchesView(x,index,ev.vt,ev.aim))aim=ev.aim;
  else if(sameAsLast)aim=ev.aim;
  else if(Number.isFinite(ev.vt)){const hist=tankRunAngleAt(x,index,ev.vt);if(hist!=null)aim=hist}
  if(aim!=null)x.lastAim[index]={a:aim,at:x.g.time};
 }
 x.g.setInput(index,ev.down,{aim,held:ev.held});
}

function drain(x,index,force){
 const q=x.inq[index];
 if(q.timer){clearTimeout(q.timer);q.timer=null}
 let forced=force;
 for(;;){
  let ev=q.pending.get(q.next);
  if(!ev){
   if(!forced||!q.pending.size)break;
   q.next=Math.min(...q.pending.keys());
   ev=q.pending.get(q.next);
  }
  forced=false;
  q.pending.delete(q.next);q.next++;
  applyEvent(x,index,ev);
 }
 if(q.pending.size){
  q.timer=setTimeout(()=>{q.timer=null;drain(x,index,true)},REORDER_WAIT);
  q.timer.unref?.();
 }
}

// Commande d'un joueur. Les requetes HTTP peuvent arriver dans le desordre
// (appui / relachement presque simultanes) : on les remet dans l'ordre par numero.
export function tankRunPress(x,index,down,ammo,seq,epoch,extra){
 x.access=Date.now();
 const q=x.inq[index];
 if(q.epoch!==epoch){
  q.epoch=epoch;q.next=1;q.pending.clear();
  if(q.timer){clearTimeout(q.timer);q.timer=null}
 }
 if(seq<q.next||q.pending.has(seq))return;
 q.pending.set(seq,{
  down:!!down,ammo,
  vt:extra&&Number.isFinite(extra.vt)?extra.vt:null,
  aim:extra&&Number.isFinite(extra.aim)?extra.aim:null,
  held:extra&&Number.isFinite(extra.held)?extra.held:null,
 });
 // garde-fou : jamais plus de 64 commandes en attente
 if(q.pending.size>64){q.next=Math.min(...q.pending.keys())}
 drain(x,index,false);
}
