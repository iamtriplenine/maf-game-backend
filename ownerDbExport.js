// MAF-DB-EXPORT-V1 : sauvegarde complete de la base, reservee au compte proprietaire.
// Produit un ZIP lisible par une IA : LISEZMOI.md, manifest.json (schema + ordre d'import), schemas SQL, une ligne JSON par enregistrement.
// Lecture seule, instantane coherent (une seule transaction), envoi en flux : peu de memoire meme si la base est grosse.
import { Router } from "express";
import zlib from "node:zlib";
import { pool } from "./db.js";
import { requireSession } from "./auth.js";
import { isOwnerAccount } from "./accountRoles.js";

export const ownerDbExportRouter = Router();
const FORMAT = "maf-db-export/1";
const q = (name) => '"' + String(name).replace(/"/g, '""') + '"';
const clean = (name) => String(name || "").replace(/^"?public"?\./, "").replace(/^"|"$/g, "").replace(/""/g, '"');
const sqlStr = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const isNum = (v) => /^-?\d+$/.test(String(v));

const SQL_TABLES = "SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname";
const SQL_COLUMNS = "SELECT c.relname AS tbl, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS def, a.attidentity::text AS identity, a.attgenerated::text AS generated FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname, a.attnum";
const SQL_CONS = "SELECT conrelid::regclass::text AS tbl, conname AS name, contype::text AS type, pg_get_constraintdef(oid) AS def, CASE WHEN contype = 'f' THEN confrelid::regclass::text END AS ref FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype IN ('p','u','c','f','x') ORDER BY 1, 2";
const SQL_INDEXES = "SELECT tablename AS tbl, indexname AS name, indexdef AS def FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname";
const SQL_SEQ = "SELECT sequencename AS name, data_type::text AS type, start_value::text AS start_value, min_value::text AS min_value, max_value::text AS max_value, increment_by::text AS increment_by, cycle, last_value::text AS last_value FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename";
const SQL_IDSEQ = "SELECT s.relname AS name FROM pg_class s JOIN pg_depend d ON d.objid = s.oid AND d.deptype = 'i' WHERE s.relkind = 'S'";

const README = `# Sauvegarde complète de la base MAF

Ce dossier est une copie **complète** (tables, structure, données) de la base PostgreSQL du jeu, prise en lecture seule à un instant précis.
Il est fait pour être donné à une IA (ou à un développeur) afin de remettre toutes les données dans une NOUVELLE base.

## Contenu
- \`manifest.json\` : LE fichier à lire en premier. Date, version du serveur, et pour chaque table : nombre de lignes, colonnes (type, nullable, défaut), contraintes, index, fichier de données. Contient aussi \`import_order\` (ordre conseillé d'insertion) et les séquences.
- \`01_schema_tables.sql\` : séquences et CREATE TABLE (sans clés étrangères ni index, pour pouvoir charger les données dans n'importe quel ordre).
- \`donnees/<table>.ndjson\` : une ligne = un enregistrement, au format JSON (clés = noms des colonnes). Fichier vide = table vide.
- \`03_contraintes_index_sequences.sql\` : clés primaires, uniques, clés étrangères, index, et remise à niveau des séquences. À exécuter APRÈS le chargement des données.

## Format des valeurs (PostgreSQL row_to_json)
- Dates et heures : texte ISO 8601, toujours en UTC.
- Entiers très grands (bigint) : à lire comme texte ou BigInt, pas comme nombre JavaScript.
- Colonnes binaires (bytea, ex. messages vocaux ou images) : texte hexadécimal commençant par \\x.
- Colonnes json/jsonb : objets JSON imbriqués. Tableaux PostgreSQL : tableaux JSON. NULL : null.

## Procédure d'import conseillée (nouvelle base PostgreSQL vide)
1. Lire \`manifest.json\`.
2. Créer la structure : soit exécuter \`01_schema_tables.sql\`, soit démarrer le nouveau serveur du jeu (il crée ses tables tout seul, certaines au premier usage). Dans ce second cas, insérer ensuite avec \`ON CONFLICT DO NOTHING\`.
3. Pour chaque table, dans l'ordre de \`import_order\`, insérer chaque ligne, par exemple avec \`INSERT INTO "table" SELECT * FROM json_populate_record(null::"table", $1::json)\` (une requête paramétrée par ligne, ou par lots dans une transaction). Colonnes générées (\`generated\` non vide dans le manifeste) : à ignorer. Colonnes d'identité « ALWAYS » : ajouter OVERRIDING SYSTEM VALUE.
4. Exécuter \`03_contraintes_index_sequences.sql\`.
5. Comparer le nombre de lignes de chaque table avec \`rows\` du manifeste.

## ATTENTION : fichier très sensible
Il contient **toutes** les données des joueurs (identifiants, codes d'accès ou leurs empreintes, jetons de session, numéros de téléphone, soldes, messages…). Ne le publie jamais, ne le mets pas sur GitHub, et supprime-le après usage. Après la migration, les anciennes sessions peuvent être invalidées si besoin.
`;

const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf, prev = 0) { let c = (prev ^ 0xffffffff) >>> 0; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

// Ecrivain ZIP en flux (methode deflate, descripteurs de donnees) : aucune dependance.
export class ZipStream {
  constructor(out) {
    this.out = out; this.offset = 0; this.entries = [];
    const d = new Date();
    this.dosTime = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
    this.dosDate = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  }
  async raw(buf) {
    if (this.out.destroyed) throw new Error("client deconnecte");
    this.offset += buf.length;
    if (!this.out.write(buf)) {
      await new Promise((ok) => { const done = () => { this.out.off("drain", done); this.out.off("close", done); ok(); }; this.out.once("drain", done); this.out.once("close", done); });
      if (this.out.destroyed) throw new Error("client deconnecte");
    }
  }
  async entry(name, fill) {
    const nameBuf = Buffer.from(name, "utf8"), start = this.offset;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0808, 6); h.writeUInt16LE(8, 8);
    h.writeUInt16LE(this.dosTime, 10); h.writeUInt16LE(this.dosDate, 12); h.writeUInt16LE(nameBuf.length, 26);
    await this.raw(Buffer.concat([h, nameBuf]));
    const def = zlib.createDeflateRaw({ level: 6 });
    let csize = 0, usize = 0, crc = 0, pend = Promise.resolve();
    def.on("data", (c) => { csize += c.length; pend = pend.then(() => this.raw(c)); });
    const finished = new Promise((ok, ko) => { def.on("end", ok); def.on("error", ko); });
    const push = async (s) => {
      const b = Buffer.isBuffer(s) ? s : Buffer.from(s, "utf8");
      if (!b.length) return;
      crc = crc32(b, crc); usize += b.length;
      if (!def.write(b)) await new Promise((ok) => def.once("drain", ok));
      await pend;
    };
    await fill(push);
    def.end(); await finished; await pend;
    const dd = Buffer.alloc(16);
    dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4); dd.writeUInt32LE(csize, 8); dd.writeUInt32LE(usize, 12);
    await this.raw(dd);
    this.entries.push({ nameBuf, crc, csize, usize, start });
  }
  async finish() {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0808, 8); c.writeUInt16LE(8, 10);
      c.writeUInt16LE(this.dosTime, 12); c.writeUInt16LE(this.dosDate, 14); c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.csize, 20); c.writeUInt32LE(e.usize, 24); c.writeUInt16LE(e.nameBuf.length, 28); c.writeUInt32LE(e.start, 42);
      await this.raw(Buffer.concat([c, e.nameBuf]));
    }
    const size = this.offset - cdStart, end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(this.entries.length, 8); end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(size, 12); end.writeUInt32LE(cdStart, 16);
    await this.raw(end);
  }
}

function colDef(c) {
  let s = "  " + q(c.name) + " " + c.type;
  if (c.identity === "a") s += " GENERATED ALWAYS AS IDENTITY";
  else if (c.identity === "d") s += " GENERATED BY DEFAULT AS IDENTITY";
  if (c.generated === "s") s += " GENERATED ALWAYS AS (" + c.def + ") STORED";
  else if (c.def) s += " DEFAULT " + c.def;
  if (c.notnull) s += " NOT NULL";
  return s;
}

function importOrder(tables, fks) {
  const deps = new Map(tables.map((t) => [t, new Set()]));
  for (const f of fks) if (deps.has(f.tbl) && deps.has(f.ref) && f.ref !== f.tbl) deps.get(f.tbl).add(f.ref);
  const done = new Set(), order = [];
  for (let guard = 0; guard <= tables.length; guard++) {
    const next = tables.filter((t) => !done.has(t) && [...deps.get(t)].every((d) => done.has(d)));
    if (!next.length) break;
    next.forEach((t) => { done.add(t); order.push(t); });
  }
  tables.filter((t) => !done.has(t)).forEach((t) => order.push(t)); // cycles : les cles etrangeres sont posees apres les donnees
  return order;
}

// client : connexion pg (ou equivalent) ; out : flux d'ecriture (reponse HTTP).
export async function streamExport(client, out) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL TIME ZONE 'UTC'");
  const tables = (await client.query(SQL_TABLES)).rows.map((r) => r.name);
  const cols = (await client.query(SQL_COLUMNS)).rows;
  const cons = (await client.query(SQL_CONS)).rows.map((r) => ({ tbl: clean(r.tbl), name: r.name, type: r.type, def: r.def, ref: r.ref ? clean(r.ref) : null }));
  const idx = (await client.query(SQL_INDEXES)).rows;
  const seqs = (await client.query(SQL_SEQ)).rows;
  const idSeq = new Set((await client.query(SQL_IDSEQ)).rows.map((r) => r.name));
  const ver = (await client.query("SELECT version() AS v, current_database() AS db")).rows[0] || {};
  const counts = {};
  for (const t of tables) counts[t] = Number((await client.query("SELECT count(*)::bigint AS n FROM " + q(t))).rows[0].n);
  const order = importOrder(tables, cons.filter((c) => c.type === "f"));
  const conNames = new Set(cons.map((c) => c.name));
  const manifest = {
    format: FORMAT,
    generated_at: new Date().toISOString(),
    source: { database: ver.db || null, server_version: ver.v || null },
    notes: "Valeurs au format row_to_json (dates ISO en UTC, bytea en hexadecimal \\x...). Voir LISEZMOI.md.",
    import_order: order,
    sequences: seqs.map((s) => ({ name: s.name, last_value: s.last_value })),
    tables: tables.map((t) => ({
      name: t, rows: counts[t], file: "donnees/" + t + ".ndjson",
      columns: cols.filter((c) => c.tbl === t).map((c) => ({ name: c.name, type: c.type, nullable: !c.notnull, default: c.def || null, identity: c.identity || "", generated: c.generated || "" })),
      constraints: cons.filter((c) => c.tbl === t).map((c) => ({ name: c.name, type: { p: "primary_key", u: "unique", c: "check", f: "foreign_key", x: "exclude" }[c.type] || c.type, definition: c.def, references: c.ref })),
      indexes: idx.filter((i) => i.tbl === t && !conNames.has(i.name)).map((i) => ({ name: i.name, definition: i.def })),
    })),
  };
  const z = new ZipStream(out);
  await z.entry("LISEZMOI.md", (push) => push(README));
  await z.entry("manifest.json", (push) => push(JSON.stringify(manifest, null, 2)));
  await z.entry("01_schema_tables.sql", async (push) => {
    await push("-- Structure des tables (sans cles etrangeres ni index). Genere le " + manifest.generated_at + "\n\n");
    for (const s of seqs) {
      if (idSeq.has(s.name)) continue;
      let l = "CREATE SEQUENCE IF NOT EXISTS " + q(s.name) + " AS " + s.type;
      if (isNum(s.increment_by)) l += " INCREMENT BY " + s.increment_by;
      if (isNum(s.min_value)) l += " MINVALUE " + s.min_value;
      if (isNum(s.max_value)) l += " MAXVALUE " + s.max_value;
      if (isNum(s.start_value)) l += " START WITH " + s.start_value;
      if (s.cycle) l += " CYCLE";
      await push(l + ";\n");
    }
    for (const t of tables) await push("\nCREATE TABLE IF NOT EXISTS " + q(t) + " (\n" + cols.filter((c) => c.tbl === t).map(colDef).join(",\n") + "\n);\n");
  });
  for (const t of tables) {
    await z.entry("donnees/" + t + ".ndjson", async (push) => {
      await client.query("DECLARE mafc NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS j FROM " + q(t) + " t");
      for (;;) {
        const { rows } = await client.query("FETCH 500 FROM mafc");
        if (!rows.length) break;
        await push(rows.map((r) => r.j).join("\n") + "\n");
      }
      await client.query("CLOSE mafc");
    });
  }
  await z.entry("03_contraintes_index_sequences.sql", async (push) => {
    await push("-- A executer APRES le chargement des donnees.\n\n");
    for (const kind of ["p", "u", "c", "x", "f"]) {
      for (const c of cons.filter((x) => x.type === kind)) await push("ALTER TABLE " + q(c.tbl) + " ADD CONSTRAINT " + q(c.name) + " " + c.def + ";\n");
    }
    await push("\n");
    for (const i of idx.filter((x) => !conNames.has(x.name))) await push(i.def.replace(/^CREATE (UNIQUE )?INDEX /, "CREATE $1INDEX IF NOT EXISTS ") + ";\n");
    await push("\n");
    for (const s of seqs) if (s.last_value !== null && s.last_value !== undefined && isNum(s.last_value)) await push("SELECT setval(" + sqlStr(q(s.name)) + ", " + s.last_value + ", true);\n");
  });
  await z.finish();
}

let running = false, lastAt = 0;
ownerDbExportRouter.post("/db-export", requireSession, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "Base de donnees indisponible." });
    if (!(await isOwnerAccount(req.userId, pool))) return res.status(403).json({ error: "Réservé au compte propriétaire." });
    const code = String((req.body || {}).code || "");
    if (code !== (process.env.MAF_EXPORT_CODE || "0852")) return res.status(403).json({ error: "Code incorrect." });
    if (running) return res.status(429).json({ error: "Une sauvegarde est déjà en cours." });
    if (Date.now() - lastAt < 15000) return res.status(429).json({ error: "Patiente quelques secondes avant une nouvelle sauvegarde." });
  } catch (error) {
    console.error("db-export controle:", error.message);
    return res.status(503).json({ error: "Sauvegarde indisponible." });
  }
  running = true; lastAt = Date.now();
  let client;
  try {
    client = await pool.connect();
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
    res.status(200);
    res.set({ "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="maf-sauvegarde-' + stamp + '.zip"', "Cache-Control": "no-store" });
    await streamExport(client, res);
    res.end();
  } catch (error) {
    console.error("db-export:", error.message);
    if (!res.headersSent) res.status(500).json({ error: "La sauvegarde a échoué." }); else res.destroy(error);
  } finally {
    if (client) { try { await client.query("ROLLBACK"); } catch (e) { /* ignore */ } client.release(); }
    running = false;
  }
});
