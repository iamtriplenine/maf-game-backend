// MAF-USERS-TEXT-V1 : fichier texte classe par utilisateur (profil complet + toutes ses donnees liees), reserve au proprietaire.
// Lecture seule, instantane coherent, envoi en flux. Les liens utilisateur sont detectes via les cles etrangeres,
// puis les colonnes *user_id / owner_id / sender_id... et pseudo_key. Rien n'est perdu : ce qui n'est lie a personne va en annexe.
import { Router } from "express";
import { pool } from "./db.js";
import { requireSession } from "./auth.js";
import { isOwnerAccount } from "./accountRoles.js";

export const ownerUsersExportRouter = Router();
const q = (name) => '"' + String(name).replace(/"/g, '""') + '"';
const clean = (name) => String(name || "").replace(/^"?public"?\./, "").replace(/^"|"$/g, "").replace(/""/g, '"');
const ID_NAMES = new Set(["owner_id", "sender_id", "recipient_id", "receiver_id", "winner_id", "loser_id", "player_id", "partner_id", "referrer_id", "referred_id", "creator_id", "author_id", "giver_id", "account_id", "buyer_id", "seller_id"]);
const INT_TYPES = new Set(["integer", "bigint", "smallint"]);
const CHUNK = 50, PER_USER_MAX = 2000, APPENDIX_MAX = 5000;

const SQL_TABLES = "SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname";
const SQL_COLUMNS = "SELECT c.relname AS tbl, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname, a.attnum";
const SQL_FKS = "SELECT conrelid::regclass::text AS tbl, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype = 'f'";

const MAXS = 300;
function shrink(v) {
  if (typeof v === "string") return v.length > MAXS ? v.slice(0, 120) + "…[" + v.length + " caractères]" : v;
  if (Array.isArray(v)) return v.map(shrink);
  if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[k] = shrink(v[k]); return o; }
  return v;
}
const parse = (j) => JSON.parse(j);
const oneLine = (obj) => JSON.stringify(shrink(obj));
const selectList = (cols) => cols.map((c) => c.type === "bytea" ? "('<binaire ' || octet_length(" + q(c.name) + ") || ' octets>') AS " + q(c.name) : q(c.name)).join(", ");

function makeWriter(out) {
  return async (text) => {
    if (out.destroyed) throw new Error("client deconnecte");
    if (!out.write(text, "utf8")) {
      await new Promise((ok) => { const done = () => { out.off("drain", done); out.off("close", done); ok(); }; out.once("drain", done); out.once("close", done); });
      if (out.destroyed) throw new Error("client deconnecte");
    }
  };
}

export async function streamUsersText(client, out) {
  const w = makeWriter(out);
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL TIME ZONE 'UTC'");
  const tables = (await client.query(SQL_TABLES)).rows.map((r) => r.name);
  if (!tables.includes("maf_users")) throw new Error("table maf_users introuvable");
  const colsBy = new Map(tables.map((t) => [t, []]));
  for (const r of (await client.query(SQL_COLUMNS)).rows) if (colsBy.has(r.tbl)) colsBy.get(r.tbl).push({ name: r.name, type: r.type });
  const fkCols = new Map(); // table -> colonnes qui pointent vers maf_users
  for (const r of (await client.query(SQL_FKS)).rows) {
    const m = /FOREIGN KEY \(([^)]+)\) REFERENCES (?:public\.)?"?maf_users"?\s*\(/.exec(r.def || "");
    if (!m) continue;
    const t = clean(r.tbl);
    if (!fkCols.has(t)) fkCols.set(t, new Set());
    m[1].split(",").map((s) => clean(s.trim())).forEach((c) => fkCols.get(t).add(c));
  }
  const links = []; // { tbl, col, kind: 'id'|'key', how }
  for (const t of tables) {
    if (t === "maf_users") continue;
    for (const c of colsBy.get(t)) {
      if (fkCols.get(t)?.has(c.name)) links.push({ tbl: t, col: c.name, kind: "id", how: "cle etrangere" });
      else if ((/(^|_)user_id$/.test(c.name) || ID_NAMES.has(c.name)) && INT_TYPES.has(c.type)) links.push({ tbl: t, col: c.name, kind: "id", how: "nom de colonne" });
      else if (c.name === "pseudo_key" && c.type === "text") links.push({ tbl: t, col: c.name, kind: "key", how: "pseudo_key" });
    }
  }
  const linkedTables = new Set(links.map((l) => l.tbl));
  const unlinked = tables.filter((t) => t !== "maf_users" && !linkedTables.has(t));
  const counts = {};
  for (const t of tables) counts[t] = Number((await client.query("SELECT count(*)::bigint AS n FROM " + q(t))).rows[0].n);
  const index = (await client.query("SELECT id, pseudo FROM maf_users ORDER BY id")).rows;
  const ver = (await client.query("SELECT version() AS v, current_database() AS db")).rows[0] || {};
  const bar = "=".repeat(80);

  await w([
    "SAUVEGARDE PAR UTILISATEUR - MAF", bar,
    "Genere le : " + new Date().toISOString() + " (UTC)",
    "Base : " + (ver.db || "?") + " / " + (ver.v || "?"),
    "Nombre d'utilisateurs : " + index.length, "",
    "COMMENT LIRE CE FICHIER",
    "- Un bloc par utilisateur (ordre des ID) : son profil complet (table maf_users), puis toutes ses donnees liees, table par table.",
    "- Chaque enregistrement lie tient sur une ligne JSON. Les dates sont en UTC.",
    "- MOTS DE PASSE : le code d'acces (10 chiffres) n'est PAS stocke en clair, seulement son empreinte scrypt. Elle est incluse dans le profil",
    "  (champs code_hash et code_salt). Avec ces deux valeurs, une nouvelle base reconnait le meme code. Le code en clair ne peut pas etre retrouve.",
    "- Les textes tres longs sont raccourcis ([N caracteres]) et les fichiers binaires (voix, images) sont remplaces par leur taille.",
    "  Pour tout recuperer sans aucune perte, utilise la sauvegarde complete (code 0852).",
    "- Les anciennes sessions ne sont pas conservees : apres migration, chaque joueur se reconnecte avec son pseudo et son code.",
    "- FICHIER TRES SENSIBLE : ne le publie jamais (pas de GitHub), supprime-le apres usage.",
    "- Pour une IA : reinserer d'abord chaque utilisateur (profil), puis ses lignes liees, puis l'annexe. Les liens sont indiques entre crochets : [table] via colonne.",
    "", "TABLES (nombre de lignes)",
    ...tables.map((t) => "  " + t + " : " + counts[t] + (t === "maf_users" ? " (profils)" : linkedTables.has(t) ? " (liee aux utilisateurs)" : " (annexe : non liee a un utilisateur)")),
    "", "LIENS UTILISATEUR DETECTES",
    ...(links.length ? links.map((l) => "  [" + l.tbl + "] via " + l.col + " (" + l.how + ")") : ["  aucun"]),
    "", "SOMMAIRE DES UTILISATEURS",
    ...index.map((u) => "  n°" + u.id + " : " + u.pseudo), "", ""].join("\n"));

  const selUsers = selectList(colsBy.get("maf_users"));
  await client.query("DECLARE mafu NO SCROLL CURSOR FOR SELECT row_to_json(q)::text AS j FROM (SELECT " + selUsers + " FROM maf_users ORDER BY id) q");
  for (;;) {
    const batch = (await client.query("FETCH " + CHUNK + " FROM mafu")).rows.map((r) => parse(r.j));
    if (!batch.length) break;
    const ids = batch.map((u) => u.id), keys = batch.map((u) => u.pseudo_key);
    const data = new Map(); // "tbl|col" -> Map(valeur -> lignes)
    for (const l of links) {
      const sel = selectList(colsBy.get(l.tbl));
      const cast = l.kind === "id" ? "bigint" : "text";
      const sql = "SELECT row_to_json(q)::text AS j FROM (SELECT " + sel + " FROM " + q(l.tbl) + " WHERE " + q(l.col) + " = ANY($1::" + cast + "[]) ORDER BY ctid LIMIT 20000) q";
      const m = new Map();
      for (const r of (await client.query(sql, [l.kind === "id" ? ids : keys])).rows) {
        const row = parse(r.j), k = String(row[l.col]);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(row);
      }
      data.set(l.tbl + "|" + l.col, m);
    }
    for (const u of batch) {
      const lines = [bar, "UTILISATEUR n°" + u.id + " - pseudo : " + u.pseudo + (u.client_id ? " - ID client : " + u.client_id : ""), bar, "PROFIL (maf_users)"];
      for (const k of Object.keys(u)) {
        const v = shrink(u[k]);
        lines.push("  " + k + " : " + (v !== null && typeof v === "object" ? JSON.stringify(v) : String(v)) + (k === "code_hash" ? "   <- empreinte scrypt du code d'acces (mot de passe)" : k === "code_salt" ? "   <- sel associe a code_hash" : ""));
      }
      let any = false;
      for (const l of links) {
        const rows = data.get(l.tbl + "|" + l.col).get(String(l.kind === "id" ? u.id : u.pseudo_key));
        if (!rows || !rows.length) continue;
        if (!any) { lines.push("", "DONNEES LIEES"); any = true; }
        lines.push("  [" + l.tbl + "] via " + l.col + " - " + rows.length + " ligne(s)");
        rows.slice(0, PER_USER_MAX).forEach((r, i) => lines.push("    " + (i + 1) + ". " + oneLine(r)));
        if (rows.length > PER_USER_MAX) lines.push("    ... " + (rows.length - PER_USER_MAX) + " ligne(s) de plus (voir la sauvegarde complete 0852)");
      }
      if (!any) lines.push("", "DONNEES LIEES : aucune");
      await w(lines.join("\n") + "\n\n");
    }
  }
  await client.query("CLOSE mafu");

  await w(bar + "\nANNEXE : DONNEES NON RATTACHEES A UN UTILISATEUR\n" + bar + "\n\n");
  for (const t of unlinked) {
    await w("[" + t + "] - " + counts[t] + " ligne(s)\n");
    if (!counts[t]) { await w("\n"); continue; }
    await client.query("DECLARE mafa NO SCROLL CURSOR FOR SELECT row_to_json(q)::text AS j FROM (SELECT " + selectList(colsBy.get(t)) + " FROM " + q(t) + " ORDER BY ctid) q");
    let n = 0;
    for (;;) {
      const rows = (await client.query("FETCH 500 FROM mafa")).rows;
      if (!rows.length) break;
      let text = "";
      for (const r of rows) { if (n < APPENDIX_MAX) text += "  " + (n + 1) + ". " + oneLine(parse(r.j)) + "\n"; n++; }
      if (text) await w(text);
    }
    await client.query("CLOSE mafa");
    if (n > APPENDIX_MAX) await w("  ... " + (n - APPENDIX_MAX) + " ligne(s) de plus (voir la sauvegarde complete 0852)\n");
    await w("\n");
  }
  for (const t of [...linkedTables]) {
    const conds = links.filter((l) => l.tbl === t).map((l) => "COALESCE(" + q(l.col) + " IN (SELECT " + (l.kind === "id" ? "id" : "pseudo_key") + " FROM maf_users), false)");
    const where = "NOT (" + conds.join(" OR ") + ")";
    const n = Number((await client.query("SELECT count(*)::bigint AS n FROM " + q(t) + " WHERE " + where)).rows[0].n);
    if (!n) continue;
    await w("[" + t + "] - " + n + " ligne(s) sans utilisateur existant\n");
    const rows = (await client.query("SELECT row_to_json(q)::text AS j FROM (SELECT " + selectList(colsBy.get(t)) + " FROM " + q(t) + " WHERE " + where + " ORDER BY ctid LIMIT " + APPENDIX_MAX + ") q")).rows;
    await w(rows.map((r, i) => "  " + (i + 1) + ". " + oneLine(parse(r.j))).join("\n") + "\n");
    if (n > APPENDIX_MAX) await w("  ... " + (n - APPENDIX_MAX) + " ligne(s) de plus (voir la sauvegarde complete 0852)\n");
    await w("\n");
  }
  await w("FIN DU FICHIER\n");
}

let running = false, lastAt = 0;
ownerUsersExportRouter.post("/users-text-export", requireSession, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "Base de donnees indisponible." });
    if (!(await isOwnerAccount(req.userId, pool))) return res.status(403).json({ error: "Réservé au compte propriétaire." });
    const code = String((req.body || {}).code || "");
    if (code !== (process.env.MAF_USERS_EXPORT_CODE || "0851")) return res.status(403).json({ error: "Code incorrect." });
    if (running) return res.status(429).json({ error: "Un export est déjà en cours." });
    if (Date.now() - lastAt < 15000) return res.status(429).json({ error: "Patiente quelques secondes avant un nouvel export." });
  } catch (error) {
    console.error("users-text-export controle:", error.message);
    return res.status(503).json({ error: "Export indisponible." });
  }
  running = true; lastAt = Date.now();
  let client;
  try {
    client = await pool.connect();
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
    res.status(200);
    res.set({ "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": 'attachment; filename="maf-utilisateurs-' + stamp + '.txt"', "Cache-Control": "no-store" });
    await streamUsersText(client, res);
    res.end();
  } catch (error) {
    console.error("users-text-export:", error.message);
    if (!res.headersSent) res.status(500).json({ error: "L'export a échoué." }); else res.destroy(error);
  } finally {
    if (client) { try { await client.query("ROLLBACK"); } catch (e) { /* ignore */ } client.release(); }
    running = false;
  }
});
