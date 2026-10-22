// Chat global : tout le monde peut LIRE, il faut etre connecte pour ECRIRE.
// Routes : GET /api/chat?after=<id>   POST /api/chat { body }
import { Router } from "express";
import { pool } from "./db.js";
import { ensureTable, requireSession } from "./auth.js";

const MAX_LENGTH = 200; // caracteres par message
// Nombre maximum de messages gardes dans la base : au-dela, les plus anciens sont
// supprimes automatiquement. Un message pese environ 0,3 Ko, donc 200 messages ~ 60 Ko.
// Modifiable sur Render sans toucher au code : variable CHAT_MAX_MESSAGES.
const MAX_MESSAGES = Math.max(20, Number.parseInt(process.env.CHAT_MAX_MESSAGES || "", 10) || 200);
const FIRST_LOAD = MAX_MESSAGES; // premier chargement : tout l'historique garde
const NEXT_LOAD = 50; // messages renvoyes au maximum ensuite
const MIN_DELAY = 1500; // 1 message toutes les 1,5 s par compte
const PER_MINUTE = 15; // et 15 messages par minute au maximum

const fail = (res, status, error) => res.status(status).json({ error });

let tableReady = null;
function ensureChatTable() {
  if (!tableReady) {
    tableReady = ensureTable()
      .then(() =>
        pool.query(
          `create table if not exists maf_chat (
             id serial primary key,
             user_id integer not null,
             body text not null,
             created_at timestamptz not null default now()
           )`
        )
      )
      .then(() => prune())
      .catch((error) => {
        tableReady = null;
        throw error;
      });
  }
  return tableReady;
}

const toMessage = (row) => ({
  id: row.id,
  user_id: row.user_id,
  pseudo: row.pseudo || null, // si le compte n'existe plus, l'appli affiche son ID
  body: row.body,
  created_at: row.created_at,
});

// anti-spam en memoire : { last, times[] } par compte
const recent = new Map();
function tooFast(userId) {
  const now = Date.now();
  const entry = recent.get(userId) || { last: 0, times: [] };
  entry.times = entry.times.filter((time) => now - time < 60000);
  if (now - entry.last < MIN_DELAY || entry.times.length >= PER_MINUTE) {
    recent.set(userId, entry);
    return true;
  }
  entry.last = now;
  entry.times.push(now);
  recent.set(userId, entry);
  return false;
}

// Garde seulement les MAX_MESSAGES plus recents (supprime le haut de l'historique).
async function prune() {
  await pool.query(
    "delete from maf_chat where id <= (select id from maf_chat order by id desc offset $1 limit 1)",
    [MAX_MESSAGES]
  );
}

export const chatRouter = Router();

chatRouter.use("/chat", (_req, res, next) => {
  if (!pool) return fail(res, 503, "Base de donnees non configuree.");
  ensureChatTable().then(
    () => next(),
    (error) => {
      console.error("Table maf_chat :", error.message);
      fail(res, 500, "Erreur base de donnees.");
    }
  );
});

chatRouter.get("/chat", async (req, res) => {
  const after = Number.parseInt(String(req.query.after ?? "0"), 10);
  const afterId = Number.isSafeInteger(after) && after > 0 ? after : 0;
  const limit = afterId > 0 ? NEXT_LOAD : FIRST_LOAD;
  try {
    const result = await pool.query(
      `select * from (
         select m.id, m.user_id, m.body, m.created_at, u.pseudo
         from maf_chat m left join maf_users u on u.id = m.user_id
         where m.id > $1
         order by m.id desc
         limit $2
       ) t order by id asc`,
      [afterId, limit]
    );
    res.set("Cache-Control", "no-store");
    res.json({ messages: result.rows.map(toMessage) });
  } catch (error) {
    console.error("chat get :", error.message);
    fail(res, 500, "Erreur serveur, reessaie.");
  }
});

chatRouter.post("/chat", requireSession, async (req, res) => {
  const raw = typeof req.body?.body === "string" ? req.body.body : "";
  // espaces et retours a la ligne simplifies, caracteres de controle retires
  const body = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!body) return fail(res, 400, "Ecris un message.");
  if (body.length > MAX_LENGTH) return fail(res, 400, `Message trop long (${MAX_LENGTH} caracteres maximum).`);
  if (tooFast(req.userId)) return fail(res, 429, "Doucement : attends une seconde avant d'ecrire encore.");
  try {
    const user = await pool.query("select id from maf_users where id = $1", [req.userId]);
    if (!user.rows[0]) return fail(res, 401, "Compte introuvable.");
    const result = await pool.query(
      `with new_message as (
         insert into maf_chat (user_id, body) values ($1, $2) returning *
       )
       select n.id, n.user_id, n.body, n.created_at, u.pseudo
       from new_message n left join maf_users u on u.id = n.user_id`,
      [req.userId, body]
    );
    res.json({ message: toMessage(result.rows[0]) });

    // nettoyage immediat : la base ne depasse jamais MAX_MESSAGES
    prune().catch((error) => console.error("chat nettoyage :", error.message));
  } catch (error) {
    console.error("chat post :", error.message);
    fail(res, 500, "Erreur serveur, reessaie.");
  }
});
