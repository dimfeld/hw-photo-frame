import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Library } from '../src/lib/server/library';
import { prepare, DIVIDER_WIDTH, HEIGHT, isHeif, isJpeg, PORTRAIT_WIDTH, WIDTH } from '../src/lib/server/images';
const libraries: Library[] = [];
afterEach(() => { for (const lib of libraries.splice(0)) lib.db.close(); });
function library(path = ':memory:') { const lib = new Library(path); libraries.push(lib); return lib; }
const photo = () => sharp({ create: { width: 100, height: 200, channels: 3, background: '#ff0000' } }).png().toBuffer();
const solid = (width: number, height: number, background: string) =>
  sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
const raw = (jpeg: Buffer) => sharp(jpeg).removeAlpha().raw().toBuffer();
const pixel = (pixels: Buffer, x: number, y: number) => {
  const offset = (y * WIDTH + x) * 3;
  return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
};

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
  test('contain adds black borders and cover fills the panel in baseline JPEG images', async () => {
    const input = await photo();
    const contain = await prepare(input, 'contain');
    const cover = await prepare(input, 'cover');
    const [containPixels, coverPixels, metadata] = await Promise.all([
      raw(contain), raw(cover), sharp(contain).metadata()
    ]);
    expect(pixel(containPixels, 0, 0).every(channel => channel < 10)).toBe(true);
    expect(pixel(containPixels, WIDTH / 2, HEIGHT / 2)[0]).toBeGreaterThan(240);
    expect(pixel(coverPixels, 0, 0)[0]).toBeGreaterThan(240);
    expect(pixel(coverPixels, WIDTH - 1, HEIGHT - 1)[0]).toBeGreaterThan(240);
    expect([metadata.width, metadata.height, metadata.format, metadata.isProgressive])
      .toEqual([WIDTH, HEIGHT, 'jpeg', false]);
  });
  test('EXIF orientation is applied before fitting', async () => {
    const input = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#00ff00' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const result = await prepare(input, 'contain');
    const pixels = await raw(result);
    // Rotated portrait is 300 pixels wide, centered at x=362..661.
    expect(pixel(pixels, 200, 300).every(channel => channel < 10)).toBe(true);
    expect(pixel(pixels, 512, 300)[1]).toBeGreaterThan(240);
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
    expect(isJpeg((await lib.image(a.id, 'cover'))!)).toBe(true);
    expect(lib.remove(a.id)).toBe(true);
    expect(await lib.image(a.id, 'contain')).toBeNull();
    expect(lib.next(a.id, null)?.id).toBe(b.id);
    expect(lib.next(b.id, null)?.id).toBe(b.id);
  });
  test('portrait photos use the next portrait partner and a two-pixel black divider', async () => {
    const lib = library();
    const red = await lib.add('red.png', await solid(100, 200, '#ff0000'));
    const landscape = await lib.add('green.png', await solid(200, 100, '#00ff00'));
    await lib.add('blue.png', await solid(100, 200, '#0000ff'));

    const paired = await lib.frame(red.id, 'contain');
    const pixels = await raw(paired!);
    expect(pixel(pixels, Math.floor(PORTRAIT_WIDTH / 2), HEIGHT / 2)[0]).toBeGreaterThan(240);
    for (let x = PORTRAIT_WIDTH; x < PORTRAIT_WIDTH + DIVIDER_WIDTH; x++) {
      expect(pixel(pixels, x, HEIGHT / 2).every(channel => channel < 50)).toBe(true);
    }
    expect(pixel(pixels, PORTRAIT_WIDTH + DIVIDER_WIDTH + Math.floor(PORTRAIT_WIDTH / 2), HEIGHT / 2)[2])
      .toBeGreaterThan(240);
    expect(await lib.frame(landscape.id, 'contain')).toEqual(await lib.image(landscape.id, 'contain'));
  });
  test('a portrait remains full-screen when no other portrait exists', async () => {
    const lib = library();
    const red = await lib.add('red.png', await photo());
    await lib.add('green.png', await solid(200, 100, '#00ff00'));
    expect(await lib.frame(red.id, 'cover')).toEqual(await lib.image(red.id, 'cover'));
  });
  test('JPEG frames include the composed display frame', async () => {
    const lib = library();
    const red = await lib.add('red.png', await solid(200, 100, '#ff0000'));
    const jpeg = await lib.frame(red.id, 'cover');
    const metadata = await sharp(jpeg!).metadata();
    expect([metadata.width, metadata.height, metadata.format]).toEqual([WIDTH, HEIGHT, 'jpeg']);
  });
  test('RGB565 data from an older database is rebuilt lazily as JPEG', async () => {
    const lib = library();
    const red = await lib.add('red.png', await photo());
    await lib.add('blue.png', await solid(100, 200, '#0000ff'));
    const legacy = Buffer.alloc(WIDTH * HEIGHT * 2);
    lib.db.query(`UPDATE photos SET contain=?,cover=?,portrait=NULL,pair_contain=NULL,pair_cover=NULL
      WHERE id=?`).run(legacy, legacy, red.id);
    const paired = await lib.frame(red.id, 'contain');
    expect(isJpeg(paired!)).toBe(true);
    const migrated = lib.db.query('SELECT contain,cover,portrait FROM photos WHERE id=?').get(red.id) as
      { contain: Uint8Array; cover: Uint8Array; portrait: number };
    expect(isJpeg(migrated.contain)).toBe(true);
    expect(isJpeg(migrated.cover)).toBe(true);
    expect(migrated.portrait).toBe(1);
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
        expect(isJpeg((await second.image(added.id, 'cover'))!)).toBe(true);
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
