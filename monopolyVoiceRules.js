// Limites et controles des vocaux de partie (distincts du chat public).
export const VOICE_LIMIT = 10;
export const VOICE_MAX_MS = 20_000;
export const VOICE_MIN_MS = 600;
export const VOICE_MAX_BYTES = 600 * 1024;

export function parseVoiceDuration(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms >= VOICE_MIN_MS && ms <= VOICE_MAX_MS ? Math.round(ms) : null;
}
export function sniffVoiceMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'audio/webm';
  if (buf.toString('latin1', 4, 8) === 'ftyp') return 'audio/mp4';
  if (buf.toString('latin1', 0, 4) === 'OggS') return 'audio/ogg';
  return null;
}
export function pruneOldestIds(ids, limit = VOICE_LIMIT) {
  return [...ids].sort((a,b)=>b-a).slice(limit);
}
