// Chat global : tout le monde peut LIRE, il faut etre connecte pour ECRIRE.
// Routes : GET /api/chat?after=<id>   POST /api/chat { body }
//          POST /api/chat/voice { audio (base64), ms }   GET /api/chat/<id>/audio
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
// Vocaux : 20 secondes maximum, et on ne garde que les derniers (ils pesent ~100 Ko chacun).
// Modifiable sur Render : variable CHAT_MAX_VOICES.
const MAX_VOICE_MS = 20000;
const MAX_VOICE_BYTES = 600 * 1024;
const MIN_VOICE_MS = 300;
const MAX_VOICES = Math.max(5, Number.parseInt(process.env.CHAT_MAX_VOICES || "", 10) || 40);
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
      .then(() =>
        pool.query(
          `alter table maf_chat
             add column if not exists audio bytea,
             add column if not exists audio_mime text,
             add column if not exists audio_ms integer`
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
  audio_ms: row.audio_ms ?? null, // vocal : duree en ms (le son est sur /api/chat/<id>/audio)
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
  // les vocaux plus anciens que les MAX_VOICES derniers sont supprimes (poids de la base)
  await pool.query(
    `delete from maf_chat
     where audio is not null
       and id <= (select id from maf_chat where audio is not null order by id desc offset $1 limit 1)`,
    [MAX_VOICES]
  );
}

// Reconnait le vrai format du fichier (on ne fait pas confiance au type annonce par le telephone)
function sniffAudio(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "audio/webm";
  if (buf.toString("latin1", 4, 8) === "ftyp") return "audio/mp4";
  if (buf.toString("latin1", 0, 4) === "OggS") return "audio/ogg";
  return null;
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
         select m.id, m.user_id, m.body, m.audio_ms, m.created_at, u.pseudo
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
       select n.id, n.user_id, n.body, n.audio_ms, n.created_at, u.pseudo
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

// ---- Vocaux ----
chatRouter.post("/chat/voice", requireSession, async (req, res) => {
  const encoded = typeof req.body?.audio === "string" ? req.body.audio : "";
  const ms = Math.round(Number(req.body?.ms));
  if (!encoded || encoded.length > MAX_VOICE_BYTES * 1.4) return fail(res, 400, "Vocal invalide ou trop lourd.");
  if (!Number.isFinite(ms) || ms < MIN_VOICE_MS) return fail(res, 400, "Vocal trop court.");
  const audio = Buffer.from(encoded, "base64");
  if (!audio.length || audio.length > MAX_VOICE_BYTES) return fail(res, 400, "Vocal invalide ou trop lourd.");
  const mime = sniffAudio(audio);
  if (!mime) return fail(res, 400, "Format audio non reconnu.");
  if (tooFast(req.userId)) return fail(res, 429, "Doucement : attends une seconde avant d'envoyer encore.");
  try {
    const user = await pool.query("select id from maf_users where id = $1", [req.userId]);
    if (!user.rows[0]) return fail(res, 401, "Compte introuvable.");
    const result = await pool.query(
      `with new_message as (
         insert into maf_chat (user_id, body, audio, audio_mime, audio_ms)
         values ($1, '', $2, $3, $4) returning id, user_id, body, audio_ms, created_at
       )
       select n.id, n.user_id, n.body, n.audio_ms, n.created_at, u.pseudo
       from new_message n left join maf_users u on u.id = n.user_id`,
      [req.userId, audio, mime, Math.min(ms, MAX_VOICE_MS)]
    );
    res.json({ message: toMessage(result.rows[0]) });
    prune().catch((error) => console.error("chat nettoyage :", error.message));
  } catch (error) {
    console.error("chat voice :", error.message);
    fail(res, 500, "Erreur serveur, reessaie.");
  }
});

// Lecture d'un vocal. Les telephones (iPhone surtout) demandent le son par morceaux (Range) : on le gere.
chatRouter.get("/chat/:id/audio", async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id) || id <= 0) return fail(res, 404, "Vocal introuvable.");
  try {
    const result = await pool.query("select audio, audio_mime from maf_chat where id = $1 and audio is not null", [id]);
    const row = result.rows[0];
    if (!row) return fail(res, 404, "Vocal introuvable.");
    const buf = row.audio;
    const total = buf.length;
    res.set({
      "Content-Type": row.audio_mime,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    });
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
    if (range && (range[1] || range[2])) {
      let start;
      let end;
      if (range[1] === "") {
        start = Math.max(0, total - Number.parseInt(range[2], 10));
        end = total - 1;
      } else {
        start = Number.parseInt(range[1], 10);
        end = range[2] ? Math.min(Number.parseInt(range[2], 10), total - 1) : total - 1;
      }
      if (start > end || start >= total) {
        res.set("Content-Range", `bytes */${total}`);
        return res.status(416).end();
      }
      res.status(206).set({ "Content-Range": `bytes ${start}-${end}/${total}`, "Content-Length": String(end - start + 1) });
      return res.end(buf.subarray(start, end + 1));
    }
    res.set("Content-Length", String(total));
    res.end(buf);
  } catch (error) {
    console.error("chat audio :", error.message);
    fail(res, 500, "Erreur serveur, reessaie.");
  }
});
