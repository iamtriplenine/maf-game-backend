// Etape 6 : regles pures du salon d'attente. Ni solde, ni paiement, ni finale lancee.
import { qualificationWinnerId } from './tournamentQualificationGame.js';
import { qualificationDraw } from './tournamentDraw.js';

const tableNumber = value => Number.isSafeInteger(value) && value >= 1 && value <= 4;

export function finalistFromMatch(row) {
  if (!row || !tableNumber(Number(row.table_no)) || !Number.isSafeInteger(Number(row.id)) ||
      !Number.isSafeInteger(Number(row.tournament_id))) throw new Error('Plateau de qualification invalide.');
  const userId = qualificationWinnerId(row.state);
  if (userId === null) return null;
  const member = row.state.seats.find(p => p.userId === userId);
  if (!member || !member.name || row.state.game.phase !== 'over') throw new Error('Vainqueur invalide.');
  return { tournamentId: Number(row.tournament_id), table: Number(row.table_no),
    matchId: Number(row.id), userId, name: String(member.name).trim() };
}

export function finalistOverview(matches = [], finalists = []) {
  const seenTables = new Set(), seenUsers = new Set();
  for (const f of finalists) {
    const table = Number(f.table_no);
    if (!tableNumber(table) || seenTables.has(table) || seenUsers.has(Number(f.user_id)))
      throw new Error('Salon final incoherent : qualifie duplique.');
    seenTables.add(table); seenUsers.add(Number(f.user_id));
  }
  const saved = new Map(finalists.map(f => [Number(f.table_no), f]));
  const byTable = new Map();
  for (const match of matches) {
    const table = Number(match.table_no);
    if (!tableNumber(table) || byTable.has(table)) throw new Error('Plateaux incoherents.');
    byTable.set(table, match);
  }
  const tables = Array.from({length:4}, (_,i) => {
    const table=i+1, match=byTable.get(table), final=saved.get(table);
    if (final && !match) throw new Error('Qualifie sans plateau.');
    const winner=match ? finalistFromMatch(match) : null;
    if (final && (!winner || Number(final.user_id)!==winner.userId || Number(final.match_id)!==winner.matchId))
      throw new Error('Qualifie incompatible avec le resultat du plateau.');
    return {table, status:final?'qualified':!match?'not_started':winner?'pending_sync':
      match.state?.game?.phase==='over'?'review':'in_progress',
      winner: final ? {name:winner.name,table} : null};
  });
  return {tables, finalists:tables.filter(t=>t.winner).map(t=>t.winner),
    qualifiedCount: tables.filter(t=>t.status==='qualified').length,
    ready:byTable.size >= 2 && byTable.size <= 4 &&
      Array.from({length:byTable.size},(_,i)=>byTable.has(i+1)).every(Boolean) &&
      matches.every(m=>saved.has(Number(m.table_no))) };
}

// Version de demonstration reproductible : 20 joueurs fictifs. AUCUNE ecriture.
export function demoFinalistLobby(count) {
  if (!Number.isSafeInteger(count) || count<0 || count>4) throw new Error('Nombre de plateaux termines invalide.');
  const users=Array.from({length:20},(_,i)=>({userId:i+1,name:`Joueur fictif ${i+1}`}));
  const groups=qualificationDraw(users,()=>0);
  const tables=groups.map(({table,players})=>({table,status:table<=count?'qualified':'in_progress',
    winner:table<=count?{name:players[0].name,table}:null}));
  return {type:'demo',tables,finalists:tables.filter(t=>t.winner).map(t=>t.winner),
    qualifiedCount:count,ready:count===4};
}
