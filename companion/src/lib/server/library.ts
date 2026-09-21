import { Database } from 'bun:sqlite';
import { randomInt, randomUUID } from 'node:crypto';
import { combinePortraits, isJpeg, prepareBoth, type Fit } from './images';
export type Photo = { id: string; name: string; created: number };
export type Settings = { seconds: number; crossfadeSeconds: number; fit: Fit; ordering: 'sequential' | 'random' };

export class Library {
  readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS photos (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL,
        original BLOB NOT NULL, contain BLOB NOT NULL, cover BLOB NOT NULL,
        preview_contain BLOB NOT NULL, preview_cover BLOB NOT NULL,
        portrait INTEGER, pair_contain BLOB, pair_cover BLOB
      );
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);`);
    const columns = new Set((this.db.query('PRAGMA table_info(photos)').all() as { name: string }[]).map(column => column.name));
    if (!columns.has('portrait')) this.db.exec('ALTER TABLE photos ADD COLUMN portrait INTEGER');
    if (!columns.has('pair_contain')) this.db.exec('ALTER TABLE photos ADD COLUMN pair_contain BLOB');
    if (!columns.has('pair_cover')) this.db.exec('ALTER TABLE photos ADD COLUMN pair_cover BLOB');
    this.db.query('INSERT OR IGNORE INTO settings VALUES (1, ?)').run(JSON.stringify({ seconds: 10, crossfadeSeconds: 2, fit: 'contain', ordering: 'sequential' }));
  }
  list(): Photo[] {
    return this.db.query('SELECT id,name,created FROM photos ORDER BY created,id').all() as Photo[];
  }
  settings(): Settings {
    const saved = JSON.parse((this.db.query('SELECT value FROM settings WHERE id=1').get() as { value: string }).value);
    return { ...saved, crossfadeSeconds: saved.crossfadeSeconds ?? 2 };
  }
  saveSettings(value: unknown): Settings {
    const s = value as Settings;
    // Seconds become microseconds in an ESP32 signed 64-bit timer.
    if (!s || !Number.isSafeInteger(s.seconds) || s.seconds! <= 0 || s.seconds! > Math.floor(Number.MAX_SAFE_INTEGER / 1000000)
      || !Number.isSafeInteger(s.crossfadeSeconds) || s.crossfadeSeconds < 0
      || s.crossfadeSeconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000000)
      || !['contain', 'cover'].includes(s.fit) || !['sequential', 'random'].includes(s.ordering)) {
      throw new Error('Enter valid whole-second timing and display options.');
    }
    const settings = { seconds: s.seconds, crossfadeSeconds: s.crossfadeSeconds, fit: s.fit, ordering: s.ordering };
    this.db.query('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify(settings));
    return settings;
  }
  async add(name: string, original: Buffer): Promise<Photo> {
    const { contain, cover, portrait, pairContain, pairCover } = await prepareBoth(original);
    const photo = { id: randomUUID(), name, created: Date.now() };
    this.db.query(`INSERT INTO photos
      (id,name,created,original,contain,cover,preview_contain,preview_cover,portrait,pair_contain,pair_cover)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(photo.id, photo.name, photo.created,
      original, contain, cover, contain, cover,
      portrait ? 1 : 0, pairContain, pairCover);
    return photo;
  }
  remove(id: string): boolean {
    return this.db.query('DELETE FROM photos WHERE id=?').run(id).changes > 0;
  }
  private async migrateFrame(id: string): Promise<boolean> {
    const row = this.db.query(`SELECT original,contain,cover,portrait,pair_contain,pair_cover
      FROM photos WHERE id=?`).get(id) as { original: Uint8Array; contain: Uint8Array; cover: Uint8Array;
        portrait: number | null; pair_contain: Uint8Array | null; pair_cover: Uint8Array | null } | null;
    if (!row) return false;
    const pairsReady = row.portrait === 0 || (row.portrait === 1
      && row.pair_contain !== null && isJpeg(row.pair_contain)
      && row.pair_cover !== null && isJpeg(row.pair_cover));
    if (isJpeg(row.contain) && isJpeg(row.cover) && pairsReady) return true;
    const prepared = await prepareBoth(Buffer.from(row.original));
    this.db.query(`UPDATE photos SET contain=?,cover=?,preview_contain=?,preview_cover=?,
      portrait=?,pair_contain=?,pair_cover=? WHERE id=?`).run(
      prepared.contain, prepared.cover, prepared.contain, prepared.cover,
      prepared.portrait ? 1 : 0, prepared.pairContain, prepared.pairCover, id);
    return true;
  }
  async image(id: string, fit: Fit): Promise<Buffer | null> {
    if (!await this.migrateFrame(id)) return null;
    const column = fit;
    const row = this.db.query(`SELECT ${column} AS bytes FROM photos WHERE id=?`).get(id) as { bytes: Uint8Array } | null;
    return row ? Buffer.from(row.bytes) : null;
  }
  private async portraitImage(id: string, fit: Fit): Promise<{ portrait: boolean; bytes: Buffer | null } | null> {
    if (!await this.migrateFrame(id)) return null;
    const row = this.db.query(`SELECT portrait,pair_${fit} AS bytes FROM photos WHERE id=?`).get(id) as
      { portrait: number; bytes: Uint8Array | null } | null;
    if (!row) return null;
    return { portrait: row.portrait === 1, bytes: row.bytes ? Buffer.from(row.bytes) : null };
  }
  async frame(id: string, fit: Fit): Promise<Buffer | null> {
    const full = await this.image(id, fit);
    if (!full) return null;
    const primary = await this.portraitImage(id, fit);
    if (!primary?.portrait || !primary.bytes) return full;
    const photos = this.list();
    const index = photos.findIndex(photo => photo.id === id);
    for (let offset = 1; offset < photos.length; offset++) {
      const candidate = photos[(index + offset) % photos.length];
      const partner = await this.portraitImage(candidate.id, fit);
      if (partner?.portrait && partner.bytes) return await combinePortraits(primary.bytes, partner.bytes);
    }
    return full;
  }
  next(after: string | null, direction: string | null): Photo | undefined {
    const photos = this.list();
    if (!photos.length) return;
    const index = photos.findIndex(p => p.id === after);
    if (this.settings().ordering === 'random' && direction !== 'previous') {
      const candidates = photos.filter(p => photos.length === 1 || p.id !== after);
      return candidates[randomInt(candidates.length)];
    }
    if (index < 0) return photos[0];
    return photos[(index + (direction === 'previous' ? -1 : 1) + photos.length) % photos.length];
  }
}
