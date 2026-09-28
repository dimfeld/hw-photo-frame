import { Database } from 'bun:sqlite';
import { randomInt, randomUUID } from 'node:crypto';
import { MAX_ZOOM } from '../crop';
import { combinePortraits, HEIGHT, isJpeg, PORTRAIT_WIDTH, prepareBoth, prepareWorking, renderCrop, WIDTH, type Fit } from './images';
// fill replaces the global fit with the photo's own crop. solo stops a portrait photo from being paired.
export type Layout = { fill: boolean; solo: boolean; x: number; y: number; zoom: number };
export type Photo = { id: string; name: string; created: number; layout: Layout };
type PhotoRow = { id: string; name: string; created: number; fill: number; solo: number; crop_x: number; crop_y: number; crop_zoom: number };
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
        portrait INTEGER, pair_contain BLOB, pair_cover BLOB, working BLOB,
        fill INTEGER NOT NULL DEFAULT 0, solo INTEGER NOT NULL DEFAULT 0,
        crop_x REAL NOT NULL DEFAULT 0.5, crop_y REAL NOT NULL DEFAULT 0.5, crop_zoom REAL NOT NULL DEFAULT 1,
        fill_full BLOB, fill_pair BLOB
      );
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);`);
    const columns = new Set((this.db.query('PRAGMA table_info(photos)').all() as { name: string }[]).map(column => column.name));
    if (!columns.has('portrait')) this.db.exec('ALTER TABLE photos ADD COLUMN portrait INTEGER');
    if (!columns.has('pair_contain')) this.db.exec('ALTER TABLE photos ADD COLUMN pair_contain BLOB');
    if (!columns.has('pair_cover')) this.db.exec('ALTER TABLE photos ADD COLUMN pair_cover BLOB');
    const added: [string, string][] = [
      ['working', 'BLOB'], ['fill', 'INTEGER NOT NULL DEFAULT 0'], ['solo', 'INTEGER NOT NULL DEFAULT 0'],
      ['crop_x', 'REAL NOT NULL DEFAULT 0.5'], ['crop_y', 'REAL NOT NULL DEFAULT 0.5'],
      ['crop_zoom', 'REAL NOT NULL DEFAULT 1'], ['fill_full', 'BLOB'], ['fill_pair', 'BLOB']
    ];
    for (const [name, type] of added) if (!columns.has(name)) this.db.exec(`ALTER TABLE photos ADD COLUMN ${name} ${type}`);
    this.db.query('INSERT OR IGNORE INTO settings VALUES (1, ?)').run(JSON.stringify({ seconds: 10, crossfadeSeconds: 2, fit: 'contain', ordering: 'sequential' }));
  }
  list(): Photo[] {
    const rows = this.db.query(`SELECT id,name,created,fill,solo,crop_x,crop_y,crop_zoom
      FROM photos ORDER BY created,id`).all() as PhotoRow[];
    return rows.map(row => ({ id: row.id, name: row.name, created: row.created, layout: {
      fill: row.fill === 1, solo: row.solo === 1, x: row.crop_x, y: row.crop_y, zoom: row.crop_zoom
    } }));
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
    const { contain, cover, working, portrait, pairContain, pairCover } = await prepareBoth(original);
    const photo = { id: randomUUID(), name, created: Date.now(), layout: { fill: false, solo: false, x: 0.5, y: 0.5, zoom: 1 } };
    this.db.query(`INSERT INTO photos
      (id,name,created,original,contain,cover,preview_contain,preview_cover,portrait,pair_contain,pair_cover,working)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(photo.id, photo.name, photo.created,
      original, contain, cover, contain, cover,
      portrait ? 1 : 0, pairContain, pairCover, working);
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
  // Photos uploaded before working copies existed get one on first use.
  async working(id: string): Promise<Buffer | null> {
    const row = this.db.query('SELECT original,working FROM photos WHERE id=?').get(id) as
      { original: Uint8Array; working: Uint8Array | null } | null;
    if (!row) return null;
    if (row.working) return Buffer.from(row.working);
    const working = await prepareWorking(Buffer.from(row.original));
    this.db.query('UPDATE photos SET working=? WHERE id=?').run(working, id);
    return working;
  }
  async saveLayout(id: string, value: unknown): Promise<Layout | null> {
    const l = value as Layout;
    const fraction = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
    if (!l || typeof l.fill !== 'boolean' || typeof l.solo !== 'boolean' || !fraction(l.x) || !fraction(l.y)
      || typeof l.zoom !== 'number' || !Number.isFinite(l.zoom) || l.zoom < 1 || l.zoom > MAX_ZOOM) {
      throw new Error('Enter a valid photo layout.');
    }
    if (!await this.migrateFrame(id)) return null;
    const working = await this.working(id);
    if (!working) return null;
    const { portrait } = this.db.query('SELECT portrait FROM photos WHERE id=?').get(id) as { portrait: number };
    const layout = { fill: l.fill, solo: l.solo, x: l.x, y: l.y, zoom: l.zoom };
    const [fillFull, fillPair] = layout.fill ? await Promise.all([
      renderCrop(working, WIDTH, HEIGHT, layout),
      portrait === 1 ? renderCrop(working, PORTRAIT_WIDTH, HEIGHT, layout) : null
    ]) : [null, null];
    this.db.query(`UPDATE photos SET fill=?,solo=?,crop_x=?,crop_y=?,crop_zoom=?,fill_full=?,fill_pair=?
      WHERE id=?`).run(layout.fill ? 1 : 0, layout.solo ? 1 : 0, layout.x, layout.y, layout.zoom, fillFull, fillPair, id);
    return layout;
  }
  async image(id: string, fit: Fit): Promise<Buffer | null> {
    if (!await this.migrateFrame(id)) return null;
    const row = this.db.query(`SELECT ${fit} AS bytes,fill_full FROM photos WHERE id=?`).get(id) as
      { bytes: Uint8Array; fill_full: Uint8Array | null } | null;
    if (!row) return null;
    return Buffer.from(row.fill_full ?? row.bytes);
  }
  // Returns the half-width image for a photo that can be paired, or null.
  private async pairSlot(id: string, fit: Fit): Promise<Buffer | null> {
    if (!await this.migrateFrame(id)) return null;
    const row = this.db.query(`SELECT portrait,solo,pair_${fit} AS bytes,fill_pair FROM photos WHERE id=?`).get(id) as
      { portrait: number; solo: number; bytes: Uint8Array | null; fill_pair: Uint8Array | null } | null;
    if (!row || row.portrait !== 1 || row.solo === 1) return null;
    const bytes = row.fill_pair ?? row.bytes;
    return bytes ? Buffer.from(bytes) : null;
  }
  async frame(id: string, fit: Fit): Promise<Buffer | null> {
    const full = await this.image(id, fit);
    if (!full) return null;
    const primary = await this.pairSlot(id, fit);
    if (!primary) return full;
    const photos = this.list();
    const index = photos.findIndex(photo => photo.id === id);
    for (let offset = 1; offset < photos.length; offset++) {
      const candidate = photos[(index + offset) % photos.length];
      const partner = await this.pairSlot(candidate.id, fit);
      if (partner) return await combinePortraits(primary, partner);
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
