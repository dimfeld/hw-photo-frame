import { Database } from 'bun:sqlite';
import { randomInt, randomUUID } from 'node:crypto';
import { prepare, type Fit } from './images';
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
        preview_contain BLOB NOT NULL, preview_cover BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);`);
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
    const contain = await prepare(original, 'contain');
    const cover = await prepare(original, 'cover');
    const photo = { id: randomUUID(), name, created: Date.now() };
    this.db.query('INSERT INTO photos VALUES (?,?,?,?,?,?,?,?)').run(photo.id, photo.name, photo.created,
      original, contain.pixels, cover.pixels, contain.preview, cover.preview);
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
