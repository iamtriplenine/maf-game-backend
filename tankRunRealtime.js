// MAF_TANKRUN_ROOM_V1. Une simulation autoritaire par salon actif.
// Important: mode multi-instance Render non supporte sans coordination externe.
import { Game } from './tankRunEngine.js';
const active = new Map();
const MAX_IDLE = 5 * 60 * 1000;

function snapshot(g) {
  return {
    w:g.w,h:g.h, cfg:g.cfg,arena:g.arena || null,rects:g.rects,
    tanks:g.tanks,bullets:g.bullets,particles:g.particles,flashes:g.flashes,
    time:g.time,phase:g.phase,countdown:g.countdown,goTimer:g.goTimer,
    shake:g.shake,winner:g.winner,
  };
}
export function dropTankRunRuntime(id){
 const key=String(id);const x=active.get(key);
 if(x){clearInterval(x.timer);active.delete(key)}
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
 x={g,last:Date.now(),access:Date.now(),lastCheckpoint:Date.now(),inProgress:false,saving:false,timer:null,lastSequence:[-1,-1],epochs:[null,null],snapshot:()=>{x.access=Date.now();return snapshot(g)}};
 g.onOver=winner=>{if(x.inProgress)return;x.inProgress=true;Promise.resolve(onResult(room.id,winner)).catch(e=>console.error('tankrun payout',e.message))};
 x.timer=setInterval(()=>{
  if(active.get(key)!==x)return;
  const now=Date.now();const diff=Math.min(200,now-x.last);x.last=now;
  if(now-x.access>MAX_IDLE){dropTankRunRuntime(key);return}
  const steps=Math.max(1,Math.min(12,Math.round(diff/(1000/60))));
  for(let i=0;i<steps;i++)if(g.phase!=='over')g.update(diff/1000/steps);
  if(now-x.lastCheckpoint>=2000&&!x.saving&&g.phase!=='over'&&onCheckpoint){
    x.lastCheckpoint=now;x.saving=true;
    Promise.resolve(onCheckpoint(room.id,snapshot(g))).catch(e=>console.error('tankrun checkpoint',e.message)).finally(()=>{x.saving=false});
  }
 },1000/60);
 x.timer.unref?.();active.set(key,x);return x;
}
export function tankRunPress(x,index,down,ammo,seq,epoch){
 x.access=Date.now();
 if(x.epochs[index]!==epoch){x.epochs[index]=epoch;x.lastSequence[index]=-1}
 if(seq<=x.lastSequence[index])return;
 x.lastSequence[index]=seq;
 if(ammo&&x.g.tanks[index])x.g.tanks[index].ammo=ammo;
 x.g.setInput(index,down);
}
