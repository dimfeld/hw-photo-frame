import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Library } from '../src/lib/server/library';
import { prepare, FRAME_BYTES, WIDTH, HEIGHT } from '../src/lib/server/images';
const libraries: Library[] = [];
afterEach(() => { for (const lib of libraries.splice(0)) lib.db.close(); });
function library(path = ':memory:') { const lib = new Library(path); libraries.push(lib); return lib; }
const photo = () => sharp({ create: { width: 100, height: 200, channels: 3, background: '#ff0000' } }).png().toBuffer();

describe('image contract', () => {
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
    lib.saveSettings({ seconds: 300, fit: 'cover', ordering: 'random' });
    expect(lib.next(a.id, null)?.id).toBe(b.id);
    expect(lib.image(a.id, 'cover', false)?.length).toBe(FRAME_BYTES);
    expect(lib.remove(a.id)).toBe(true);
    expect(lib.image(a.id, 'contain', true)).toBeNull();
    expect(lib.next(a.id, null)?.id).toBe(b.id);
    expect(lib.next(b.id, null)?.id).toBe(b.id);
  });
  test('photos and settings survive reopening the database', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'still-test-'));
    const path = join(directory, 'library.sqlite');
    const first = new Library(path);
    try {
      const added = await first.add('persistent.png', await photo());
      first.saveSettings({ seconds: 17, fit: 'cover', ordering: 'sequential' });
      first.db.close();
      const second = new Library(path);
      try {
        expect(second.list()[0].id).toBe(added.id);
        expect(second.settings().seconds).toBe(17);
        expect(second.image(added.id, 'cover', false)?.length).toBe(FRAME_BYTES);
      } finally { second.db.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  test('invalid settings leave saved settings intact', () => {
    const lib = library();
    for (const seconds of [0, -1, 1.5, null, Infinity, '300']) {
      expect(() => lib.saveSettings({ seconds, fit: 'cover', ordering: 'sequential' })).toThrow();
    }
    expect(() => lib.saveSettings({ seconds: 1, fit: 'bad', ordering: 'bad' })).toThrow();
    expect(lib.settings()).toEqual({ seconds: 10, fit: 'contain', ordering: 'sequential' });
  });
});
