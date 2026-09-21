import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Library } from '../src/lib/server/library';
import { prepare, DIVIDER_WIDTH, FRAME_BYTES, HEIGHT, isHeif, PORTRAIT_WIDTH, WIDTH } from '../src/lib/server/images';
const libraries: Library[] = [];
afterEach(() => { for (const lib of libraries.splice(0)) lib.db.close(); });
function library(path = ':memory:') { const lib = new Library(path); libraries.push(lib); return lib; }
const photo = () => sharp({ create: { width: 100, height: 200, channels: 3, background: '#ff0000' } }).png().toBuffer();
const solid = (width: number, height: number, background: string) =>
  sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();

describe('image contract', () => {
  test('HEIC and HEIF file signatures are detected without relying on the file name', () => {
    const heic = Buffer.alloc(20);
    heic.write('ftypheic', 4, 'ascii');
    const heif = Buffer.alloc(20);
    heif.write('ftypmif1', 4, 'ascii');
    expect(isHeif(heic)).toBe(true);
    expect(isHeif(heif)).toBe(true);
    expect(isHeif(Buffer.from('not an image'))).toBe(false);
  });
  test('contain adds black borders; cover fills the panel; pixels are little-endian RGB565', async () => {
    const input = await photo();
    const contain = await prepare(input, 'contain');
    const cover = await prepare(input, 'cover');
    expect(contain.pixels.length).toBe(FRAME_BYTES);
    expect(contain.pixels.readUInt16LE(0)).toBe(0);
    expect(contain.pixels.readUInt16LE((WIDTH * (HEIGHT / 2) + WIDTH / 2) * 2)).toBe(0xf800);
    expect(cover.pixels.readUInt16LE(0)).toBe(0xf800);
    expect(cover.pixels.readUInt16LE(FRAME_BYTES - 2)).toBe(0xf800);
    const meta = await sharp(contain.preview).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([WIDTH, HEIGHT, 'jpeg']);
  });
  test('EXIF orientation is applied before fitting', async () => {
    const input = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#00ff00' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const result = await prepare(input, 'contain');
    // Rotated portrait is 300 pixels wide, centered at x=362..661.
    expect(result.pixels.readUInt16LE((WIDTH * 300 + 200) * 2)).toBe(0);
    expect(result.pixels.readUInt16LE((WIDTH * 300 + 512) * 2)).not.toBe(0);
  });
});

describe('library', () => {
  test('empty library and invalid uploads do not add rows', async () => {
    const lib = library();
    expect(lib.next(null, null)).toBeUndefined();
    await expect(lib.add('bad.jpg', Buffer.from('not an image'))).rejects.toThrow();
    expect(lib.list()).toEqual([]);
    expect(lib.remove('../anything')).toBe(false);
  });
  test('upload, forward/backward wrap, deleted cursor, and random no-repeat', async () => {
    const lib = library();
    const a = await lib.add('a.png', await photo());
    const b = await lib.add('b.png', await photo());
    expect(lib.next(null, null)?.id).toBe(a.id);
    expect(lib.next(a.id, null)?.id).toBe(b.id);
    expect(lib.next(b.id, null)?.id).toBe(a.id);
    expect(lib.next(a.id, 'previous')?.id).toBe(b.id);
    lib.saveSettings({ seconds: 300, crossfadeSeconds: 4, fit: 'cover', ordering: 'random' });
    expect(lib.next(a.id, null)?.id).toBe(b.id);
    expect(lib.image(a.id, 'cover', false)?.length).toBe(FRAME_BYTES);
    expect(lib.remove(a.id)).toBe(true);
    expect(lib.image(a.id, 'contain', true)).toBeNull();
    expect(lib.next(a.id, null)?.id).toBe(b.id);
    expect(lib.next(b.id, null)?.id).toBe(b.id);
  });
  test('portrait photos use the next portrait partner and a two-pixel black divider', async () => {
    const lib = library();
    const red = await lib.add('red.png', await solid(100, 200, '#ff0000'));
    const landscape = await lib.add('green.png', await solid(200, 100, '#00ff00'));
    await lib.add('blue.png', await solid(100, 200, '#0000ff'));

    const paired = await lib.frame(red.id, 'contain');
    expect(paired?.length).toBe(FRAME_BYTES);
    const pixel = (x: number, y = HEIGHT / 2) => paired!.readUInt16LE((y * WIDTH + x) * 2);
    expect(pixel(Math.floor(PORTRAIT_WIDTH / 2))).toBe(0xf800);
    for (let x = PORTRAIT_WIDTH; x < PORTRAIT_WIDTH + DIVIDER_WIDTH; x++) expect(pixel(x)).toBe(0x0000);
    expect(pixel(PORTRAIT_WIDTH + DIVIDER_WIDTH + Math.floor(PORTRAIT_WIDTH / 2))).toBe(0x001f);
    expect(await lib.frame(landscape.id, 'contain')).toEqual(lib.image(landscape.id, 'contain', false));
  });
  test('a portrait remains full-screen when no other portrait exists', async () => {
    const lib = library();
    const red = await lib.add('red.png', await photo());
    await lib.add('green.png', await solid(200, 100, '#00ff00'));
    expect(await lib.frame(red.id, 'cover')).toEqual(lib.image(red.id, 'cover', false));
  });
  test('portrait data is rebuilt lazily for photos from an older database', async () => {
    const lib = library();
    const red = await lib.add('red.png', await photo());
    await lib.add('blue.png', await solid(100, 200, '#0000ff'));
    lib.db.query('UPDATE photos SET portrait=NULL,pair_contain=NULL,pair_cover=NULL WHERE id=?').run(red.id);
    const paired = await lib.frame(red.id, 'contain');
    expect(paired?.readUInt16LE((PORTRAIT_WIDTH * 2))).toBe(0x0000);
    expect((lib.db.query('SELECT portrait FROM photos WHERE id=?').get(red.id) as { portrait: number }).portrait).toBe(1);
  });
  test('opening the previous database schema adds portrait columns', () => {
    const directory = mkdtempSync(join(tmpdir(), 'still-test-'));
    const path = join(directory, 'library.sqlite');
    const old = new Database(path, { create: true });
    old.exec(`CREATE TABLE photos (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL,
      original BLOB NOT NULL, contain BLOB NOT NULL, cover BLOB NOT NULL,
      preview_contain BLOB NOT NULL, preview_cover BLOB NOT NULL
    )`);
    old.close();
    const migrated = new Library(path);
    try {
      const columns = (migrated.db.query('PRAGMA table_info(photos)').all() as { name: string }[]).map(column => column.name);
      expect(columns).toContain('portrait');
      expect(columns).toContain('pair_contain');
      expect(columns).toContain('pair_cover');
    } finally {
      migrated.db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test('photos and settings survive reopening the database', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'still-test-'));
    const path = join(directory, 'library.sqlite');
    const first = new Library(path);
    try {
      const added = await first.add('persistent.png', await photo());
      first.saveSettings({ seconds: 17, crossfadeSeconds: 3, fit: 'cover', ordering: 'sequential' });
      first.db.close();
      const second = new Library(path);
      try {
        expect(second.list()[0].id).toBe(added.id);
        expect(second.settings().seconds).toBe(17);
        expect(second.settings().crossfadeSeconds).toBe(3);
        expect(second.image(added.id, 'cover', false)?.length).toBe(FRAME_BYTES);
      } finally { second.db.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  test('invalid settings leave saved settings intact', () => {
    const lib = library();
    for (const seconds of [0, -1, 1.5, null, Infinity, '300']) {
      expect(() => lib.saveSettings({ seconds, crossfadeSeconds: 2, fit: 'cover', ordering: 'sequential' })).toThrow();
    }
    for (const crossfadeSeconds of [-1, 1.5, null, Infinity, '2']) {
      expect(() => lib.saveSettings({ seconds: 1, crossfadeSeconds, fit: 'cover', ordering: 'sequential' })).toThrow();
    }
    expect(() => lib.saveSettings({ seconds: 1, crossfadeSeconds: 2, fit: 'bad', ordering: 'bad' })).toThrow();
    expect(lib.settings()).toEqual({ seconds: 10, crossfadeSeconds: 2, fit: 'contain', ordering: 'sequential' });
  });
  test('settings from an older database get the default crossfade time', () => {
    const lib = library();
    lib.db.query('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify({ seconds: 9, fit: 'cover', ordering: 'random' }));
    expect(lib.settings()).toEqual({ seconds: 9, crossfadeSeconds: 2, fit: 'cover', ordering: 'random' });
  });
});
