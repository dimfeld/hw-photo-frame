import { Database } from 'bun:sqlite';
import { randomInt, randomUUID } from 'node:crypto';
import { combinePortraits, prepareBoth, preparePortrait, type Fit } from './images';
export type Photo = { id: string; name: string; created: number };
export type Settings = { seconds: number; fit: Fit; ordering: 'sequential' | 'random' };

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
    this.db.query('INSERT OR IGNORE INTO settings VALUES (1, ?)').run(JSON.stringify({ seconds: 10, fit: 'contain', ordering: 'sequential' }));
  }
  list(): Photo[] {
    return this.db.query('SELECT id,name,created FROM photos ORDER BY created,id').all() as Photo[];
  }
  settings(): Settings {
    return JSON.parse((this.db.query('SELECT value FROM settings WHERE id=1').get() as { value: string }).value);
  }
  saveSettings(value: unknown): Settings {
    const s = value as Settings;
    // Seconds become milliseconds in an ESP32 signed 64-bit timer.
    if (!s || !Number.isSafeInteger(s.seconds) || s.seconds! <= 0 || s.seconds! > Math.floor(Number.MAX_SAFE_INTEGER / 1000000)
      || !['contain', 'cover'].includes(s.fit) || !['sequential', 'random'].includes(s.ordering)) {
      throw new Error('Enter a positive whole number of seconds and valid display options.');
    }
    const settings = { seconds: s.seconds, fit: s.fit, ordering: s.ordering };
    this.db.query('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify(settings));
    return settings;
  }
  async add(name: string, original: Buffer): Promise<Photo> {
    const { contain, cover, portrait, pairContain, pairCover } = await prepareBoth(original);
    const photo = { id: randomUUID(), name, created: Date.now() };
    this.db.query(`INSERT INTO photos
      (id,name,created,original,contain,cover,preview_contain,preview_cover,portrait,pair_contain,pair_cover)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(photo.id, photo.name, photo.created,
      original, contain.pixels, cover.pixels, contain.preview, cover.preview,
      portrait ? 1 : 0, pairContain, pairCover);
    return photo;
  }
  remove(id: string): boolean {
    return this.db.query('DELETE FROM photos WHERE id=?').run(id).changes > 0;
  }
  image(id: string, fit: Fit, preview: boolean): Buffer | null {
    const column = preview ? `preview_${fit}` : fit;
    const row = this.db.query(`SELECT ${column} AS bytes FROM photos WHERE id=?`).get(id) as { bytes: Uint8Array } | null;
    return row ? Buffer.from(row.bytes) : null;
  }
  private async portraitImage(id: string, fit: Fit): Promise<{ portrait: boolean; bytes: Buffer | null } | null> {
    const row = this.db.query(`SELECT original,portrait,pair_${fit} AS bytes FROM photos WHERE id=?`).get(id) as
      { original: Uint8Array; portrait: number | null; bytes: Uint8Array | null } | null;
    if (!row) return null;
    if (row.portrait !== null) return { portrait: row.portrait === 1, bytes: row.bytes ? Buffer.from(row.bytes) : null };
    const prepared = await preparePortrait(Buffer.from(row.original));
    this.db.query('UPDATE photos SET portrait=?,pair_contain=?,pair_cover=? WHERE id=?').run(
      prepared.portrait ? 1 : 0, prepared.pairContain, prepared.pairCover, id);
    return { portrait: prepared.portrait, bytes: fit === 'contain' ? prepared.pairContain : prepared.pairCover };
  }
  async frame(id: string, fit: Fit): Promise<Buffer | null> {
    const full = this.image(id, fit, false);
    if (!full) return null;
    const primary = await this.portraitImage(id, fit);
    if (!primary?.portrait || !primary.bytes) return full;
    const photos = this.list();
    const index = photos.findIndex(photo => photo.id === id);
    for (let offset = 1; offset < photos.length; offset++) {
      const candidate = photos[(index + offset) % photos.length];
      const partner = await this.portraitImage(candidate.id, fit);
      if (partner?.portrait && partner.bytes) return combinePortraits(primary.bytes, partner.bytes);
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
