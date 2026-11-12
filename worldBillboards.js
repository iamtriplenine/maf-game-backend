// Monde 3D : panneaux publicitaires poses par les joueurs (type, position, image JPEG).
// Pour l'instant tout le monde peut en poser (3 par compte) ; seul le proprietaire change l'image.
import { Router } from "express";
import { pool } from "./db.js";
import { requireSession } from "./auth.js";

export const worldBillboardsRouter = Router();

const TYPES = new Set(["lowpoly", "metal", "busstop", "column"]);
const MAX_PER_USER = 3;
const MAX_TOTAL = 60;
const MAX_COORD = 2000;
const MIN_DIST = 3;
const MAX_IMAGE_BYTES = 1200000;

let tableReady;
function ensureTable() {
  if (!tableReady) tableReady = pool.query(
    `CREATE TABLE IF NOT EXISTS maf_world_billboards (
       id serial PRIMARY KEY,
       owner_id integer NOT NULL REFERENCES maf_users(id) ON DELETE CASCADE,
       type varchar(16) NOT NULL,
       x double precision NOT NULL,
       z double precision NOT NULL,
       rot double precision NOT NULL,
       image bytea,
       image_version integer NOT NULL DEFAULT 0,
       created_at timestamptz NOT NULL DEFAULT now())`
  ).catch(error => { tableReady = null; throw error; });
  return tableReady;
}

const fail = (res, code, message) => res.status(code).json({ error: message });
const isNum = v => typeof v === "number" && Number.isFinite(v);
const parseId = req => { const id = Number(req.params.id); return Number.isSafeInteger(id) && id > 0 ? id : null; };

worldBillboardsRouter.get("/", requireSession, async (req, res) => {
  try {
    await ensureTable();
    const { rows } = await pool.query(
      "SELECT id, owner_id, type, x, z, rot, image_version, (image IS NOT NULL) AS has_image FROM maf_world_billboards ORDER BY id");
    res.set("Cache-Control", "no-store").json({
      boards: rows.map(r => ({ id: r.id, type: r.type, x: r.x, z: r.z, rot: r.rot,
        version: r.image_version, has_image: r.has_image, mine: r.owner_id === req.userId }))
    });
  } catch (error) { console.error("world billboards:", error.message); fail(res, 503, "Panneaux indisponibles."); }
});

worldBillboardsRouter.post("/", requireSession, async (req, res) => {
  const { type, x, z, rot } = req.body || {};
  if (!TYPES.has(type) || ![x, z, rot].every(isNum) || Math.abs(x) > MAX_COORD || Math.abs(z) > MAX_COORD || Math.abs(rot) > 1000)
    return fail(res, 400, "Emplacement invalide.");
  try {
    await ensureTable();
    const c = (await pool.query(
      "SELECT count(*)::int AS total, count(*) FILTER (WHERE owner_id=$1)::int AS mine FROM maf_world_billboards", [req.userId])).rows[0];
    if (c.mine >= MAX_PER_USER) return fail(res, 409, "Tu as déjà " + MAX_PER_USER + " panneaux. Retires-en un pour en placer un autre.");
    if (c.total >= MAX_TOTAL) return fail(res, 409, "La ville est pleine de panneaux pour le moment.");
    const near = await pool.query(
      "SELECT 1 FROM maf_world_billboards WHERE (x-$1)^2 + (z-$2)^2 < $3 LIMIT 1", [x, z, MIN_DIST * MIN_DIST]);
    if (near.rows[0]) return fail(res, 409, "Un panneau est déjà trop près de cet endroit.");
    const row = (await pool.query(
      "INSERT INTO maf_world_billboards(owner_id, type, x, z, rot) VALUES ($1,$2,$3,$4,$5) RETURNING id, image_version",
      [req.userId, type, x, z, Math.round(rot * 1000) / 1000])).rows[0];
    res.json({ id: row.id, version: row.image_version });
  } catch (error) { console.error("world billboard create:", error.message); fail(res, 503, "Pose impossible pour le moment."); }
});

worldBillboardsRouter.put("/:id/image", requireSession, async (req, res) => {
  const id = parseId(req);
  if (!id) return fail(res, 400, "Panneau inconnu.");
  const raw = req.body ? req.body.image : undefined;
  let buffer = null;
  if (raw !== null) {
    const m = typeof raw === "string" ? /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(raw) : null;
    if (!m) return fail(res, 400, "Image JPEG attendue.");
    buffer = Buffer.from(m[1], "base64");
    if (buffer.length > MAX_IMAGE_BYTES) return fail(res, 413, "Image trop lourde (1,2 Mo maximum).");
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) return fail(res, 400, "Image JPEG invalide.");
  }
  try {
    await ensureTable();
    const row = (await pool.query(
      "UPDATE maf_world_billboards SET image=$1, image_version=image_version+1 WHERE id=$2 AND owner_id=$3 RETURNING image_version",
      [buffer, id, req.userId])).rows[0];
    if (!row) return fail(res, 404, "Panneau introuvable ou qui ne t'appartient pas.");
    res.json({ version: row.image_version });
  } catch (error) { console.error("world billboard image:", error.message); fail(res, 503, "Enregistrement impossible."); }
});

worldBillboardsRouter.get("/:id/image", requireSession, async (req, res) => {
  const id = parseId(req);
  if (!id) return fail(res, 400, "Panneau inconnu.");
  try {
    await ensureTable();
    const row = (await pool.query("SELECT image FROM maf_world_billboards WHERE id=$1", [id])).rows[0];
    if (!row || !row.image) return fail(res, 404, "Pas d'image.");
    res.set("Cache-Control", "private, max-age=600").type("image/jpeg").send(row.image);
  } catch (error) { console.error("world billboard get image:", error.message); fail(res, 503, "Image indisponible."); }
});

worldBillboardsRouter.delete("/:id", requireSession, async (req, res) => {
  const id = parseId(req);
  if (!id) return fail(res, 400, "Panneau inconnu.");
  try {
    await ensureTable();
    const r = await pool.query("DELETE FROM maf_world_billboards WHERE id=$1 AND owner_id=$2", [id, req.userId]);
    if (!r.rowCount) return fail(res, 404, "Panneau introuvable ou qui ne t'appartient pas.");
    res.json({ ok: true });
  } catch (error) { console.error("world billboard delete:", error.message); fail(res, 503, "Suppression impossible."); }
});
