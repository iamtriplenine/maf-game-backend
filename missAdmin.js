// MAF-MISS-ADMIN-V1 : API du panneau administrateur Miss.
// Acces reserve a celui qui connait MISS_ADMIN_KEY (variable Render, 16 caracteres minimum).
// Le panneau est un fichier local (origine "null") : la protection repose sur la cle secrete, pas sur l'origine.
import crypto from "node:crypto";
import cors from "cors";
import express, { Router } from "express";
import { pool } from "./db.js";
import { baseUrl, fail, photoUrl, text, UUID, wrap } from "./missVotes.js";

export const missAdminRouter = Router();
missAdminRouter.use(cors({ origin: true, methods: ["GET", "POST", "DELETE", "OPTIONS"], allowedHeaders: ["Content-Type", "X-Miss-Admin"], maxAge: 600 }));
missAdminRouter.use(express.json({ limit: "20kb" }));

const fails = new Map();
function adminOnly(req, res, next) {
  const key = process.env.MISS_ADMIN_KEY || "";
  if (key.length < 16) return fail(res, 503, "MISS_ADMIN_KEY non configuree sur le serveur (16 caracteres minimum).");
  const now = Date.now(), f = fails.get(req.ip);
  if (f && f.n >= 10 && now - f.t < 600000) return fail(res, 429, "Trop d'essais. Reessaie dans 10 minutes.");
  const a = Buffer.from(String(req.headers["x-miss-admin"] || "")), b = Buffer.from(key);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    const g = f && now - f.t < 600000 ? f : { n: 0, t: now };
    g.n++; fails.set(req.ip, g);
    return fail(res, 403, "Cle incorrecte.");
  }
  fails.delete(req.ip);
  next();
}

const photoRefs = (r) => [r.photo_url, r.photo_url2, r.photo_url3];
async function dropUnusedPhotos(refs) {
  for (const v of refs) {
    if (typeof v === "string" && v.startsWith("photo:") && UUID.test(v.slice(6))) {
      await pool.query("DELETE FROM miss_photos p WHERE p.id=$1 AND NOT EXISTS (SELECT 1 FROM miss_candidates c WHERE $2 IN (c.photo_url, c.photo_url2, c.photo_url3))", [v.slice(6), v]);
    }
  }
}
const imageType = (b) =>
  b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? "image/jpeg"
  : b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? "image/png"
  : b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" ? "image/webp" : null;

missAdminRouter.get("/check", adminOnly, wrap(async (_req, res) => res.json({ success: true })));

missAdminRouter.get("/candidates", adminOnly, wrap(async (req, res) => {
  const r = await pool.query(`SELECT c.numero, c.nom, c.description, c.photo_url, c.photo_url2, c.photo_url3, c.votes,
    (SELECT count(*)::int FROM miss_vote_requests q WHERE q.candidate_numero = c.numero) AS requests FROM miss_candidates c ORDER BY c.numero`);
  res.json({ success: true, candidates: r.rows.map((c) => ({
    numero: c.numero, nom: c.nom, description: c.description, votes: c.votes, requests: c.requests,
    photos: photoRefs(c).map((v) => (v ? { ref: v, url: photoUrl(v, req) } : null)),
  })) });
}));

// Envoi d'une photo (corps = image brute). Les photos jamais rattachees a une candidate sont effacees apres 24 h.
missAdminRouter.post("/photos", adminOnly, express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "3mb" }), wrap(async (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return fail(res, 400, "Image manquante (JPEG, PNG ou WebP).");
  const mime = imageType(buf);
  if (!mime) return fail(res, 400, "Format d'image non reconnu.");
  await pool.query("DELETE FROM miss_photos p WHERE p.created_at < now() - interval '1 day' AND NOT EXISTS (SELECT 1 FROM miss_candidates c WHERE 'photo:' || p.id::text IN (c.photo_url, c.photo_url2, c.photo_url3))");
  const r = await pool.query("INSERT INTO miss_photos(mime, data) VALUES($1,$2) RETURNING id", [mime, buf]);
  res.json({ success: true, ref: "photo:" + r.rows[0].id, url: baseUrl(req) + "/api/miss/photos/" + r.rows[0].id });
}));

// Ajout ou modification (meme numero = mise a jour). Les votes ne se changent pas ici.
missAdminRouter.post("/candidates", adminOnly, wrap(async (req, res) => {
  const b = req.body || {}, numero = Number(b.numero), nom = text(b.nom, 80);
  if (!Number.isInteger(numero) || numero < 1 || numero > 9999 || !nom) return fail(res, 400, "Numero (1 a 9999) et nom obligatoires.");
  const given = Array.isArray(b.photos) ? b.photos.slice(0, 3) : [], clean = [];
  for (let i = 0; i < 3; i++) {
    const v = typeof given[i] === "string" ? given[i].trim() : "";
    if (!v) clean.push(null);
    else if (/^https:\/\/\S{3,500}$/.test(v)) clean.push(v);
    else if (v.startsWith("photo:") && UUID.test(v.slice(6)) && (await pool.query("SELECT 1 FROM miss_photos WHERE id=$1", [v.slice(6)])).rowCount) clean.push(v);
    else return fail(res, 400, "Photo " + (i + 1) + " invalide.");
  }
  const before = (await pool.query("SELECT photo_url, photo_url2, photo_url3 FROM miss_candidates WHERE numero=$1", [numero])).rows[0];
  await pool.query(
    `INSERT INTO miss_candidates(numero, nom, description, photo_url, photo_url2, photo_url3) VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(numero) DO UPDATE SET nom=EXCLUDED.nom, description=EXCLUDED.description, photo_url=EXCLUDED.photo_url, photo_url2=EXCLUDED.photo_url2, photo_url3=EXCLUDED.photo_url3`,
    [numero, nom, text(b.description, 200) || null, clean[0], clean[1], clean[2]]);
  if (before) await dropUnusedPhotos(photoRefs(before));
  res.json({ success: true, mise_a_jour: !!before });
}));

// Correction des votes (appel : "set" = total exact, "add" = ajouter ou retirer). Chaque changement est garde dans l'historique.
missAdminRouter.post("/candidates/:numero/votes", adminOnly, wrap(async (req, res) => {
  const numero = Number(req.params.numero), mode = req.body?.mode, value = Number(req.body?.value), reason = text(req.body?.reason, 200);
  if (!Number.isInteger(numero) || !["set", "add"].includes(mode) || !Number.isInteger(value) || Math.abs(value) > 10000000) return fail(res, 400, "Valeur invalide.");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const cur = (await c.query("SELECT votes, nom FROM miss_candidates WHERE numero=$1 FOR UPDATE", [numero])).rows[0];
    if (!cur) { await c.query("ROLLBACK"); return fail(res, 404, "Candidate introuvable."); }
    const apres = mode === "set" ? value : cur.votes + value;
    if (apres < 0 || apres > 10000000) { await c.query("ROLLBACK"); return fail(res, 400, "Le total doit rester entre 0 et 10 000 000."); }
    await c.query("UPDATE miss_candidates SET votes=$2 WHERE numero=$1", [numero, apres]);
    await c.query("INSERT INTO miss_vote_adjustments(candidate_numero, candidate_nom, avant, apres, raison) VALUES($1,$2,$3,$4,$5)", [numero, cur.nom, cur.votes, apres, reason || null]);
    await c.query("COMMIT");
    res.json({ success: true, avant: cur.votes, apres });
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}));

// Suppression. S'il existe des demandes de vote (paiements), il faut confirmer avec ?force=1 : elles sont alors supprimees aussi.
missAdminRouter.delete("/candidates/:numero", adminOnly, wrap(async (req, res) => {
  const numero = Number(req.params.numero), force = req.query.force === "1";
  if (!Number.isInteger(numero)) return fail(res, 400, "Numero invalide.");
  const c = await pool.connect();
  let refs = [];
  try {
    await c.query("BEGIN");
    const row = (await c.query("SELECT photo_url, photo_url2, photo_url3 FROM miss_candidates WHERE numero=$1 FOR UPDATE", [numero])).rows[0];
    if (!row) { await c.query("ROLLBACK"); return fail(res, 404, "Candidate introuvable."); }
    const n = Number((await c.query("SELECT count(*)::int AS n FROM miss_vote_requests WHERE candidate_numero=$1", [numero])).rows[0].n);
    if (n > 0 && !force) { await c.query("ROLLBACK"); return res.status(409).json({ success: false, requests: n, message: "Cette candidate a " + n + " demande(s) de vote enregistree(s)." }); }
    if (n > 0) await c.query("DELETE FROM miss_vote_requests WHERE candidate_numero=$1", [numero]);
    await c.query("DELETE FROM miss_candidates WHERE numero=$1", [numero]);
    await c.query("COMMIT");
    refs = photoRefs(row);
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  await dropUnusedPhotos(refs);
  res.json({ success: true });
}));

missAdminRouter.get("/adjustments", adminOnly, wrap(async (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  const r = await pool.query("SELECT candidate_numero, candidate_nom, avant, apres, raison, created_at FROM miss_vote_adjustments ORDER BY id DESC LIMIT $1", [limit]);
  res.json({ success: true, adjustments: r.rows });
}));
