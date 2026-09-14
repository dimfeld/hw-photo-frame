import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);

export const WIDTH = 1024;
export const HEIGHT = 600;
export const FRAME_BYTES = WIDTH * HEIGHT * 2;
export type Fit = 'contain' | 'cover';

export function isHeif(input: Uint8Array): boolean {
  if (input.length < 12 || Buffer.from(input.subarray(4, 8)).toString('ascii') !== 'ftyp') return false;
  for (let offset = 8; offset + 4 <= Math.min(input.length, 64); offset += 4) {
    if (HEIF_BRANDS.has(Buffer.from(input.subarray(offset, offset + 4)).toString('ascii'))) return true;
  }
  return false;
}

async function decodeHeif(input: Buffer): Promise<Buffer> {
  if (!isHeif(input)) return input;
  const directory = await mkdtemp(join(tmpdir(), 'still-heif-'));
  const source = join(directory, 'input.heif');
  const converted = join(directory, 'output.png');
  try {
    await writeFile(source, input);
    await execFileAsync('heif-convert', [source, converted]);
    return await readFile(converted);
  } catch (cause) {
    throw new Error('HEIC/HEIF conversion failed. Install heif-convert and check the image.', { cause });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function rgb565(rgb: Uint8Array): Buffer {
  if (rgb.length !== WIDTH * HEIGHT * 3) throw new Error('Wrong RGB image size');
  const result = Buffer.alloc(FRAME_BYTES);
  for (let src = 0, dst = 0; src < rgb.length; src += 3, dst += 2) {
    const pixel = ((rgb[src] >> 3) << 11) | ((rgb[src + 1] >> 2) << 5) | (rgb[src + 2] >> 3);
    result.writeUInt16LE(pixel, dst);
  }
  return result;
}

async function prepareDecoded(original: Buffer, fit: Fit) {
  // Sharp applies EXIF orientation before it fits the photo to the panel.
  const pixels = await sharp(original, { failOn: 'error' }).rotate()
    .resize(WIDTH, HEIGHT, { fit, background: '#000000' })
    .flatten({ background: '#000000' }).toColourspace('srgb').removeAlpha().raw().toBuffer();
  const preview = await sharp(pixels, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } }).jpeg().toBuffer();
  return { pixels: rgb565(pixels), preview };
}

export async function prepare(original: Buffer, fit: Fit) {
  return prepareDecoded(await decodeHeif(original), fit);
}

export async function prepareBoth(original: Buffer) {
  const decoded = await decodeHeif(original);
  return {
    contain: await prepareDecoded(decoded, 'contain'),
    cover: await prepareDecoded(decoded, 'cover')
  };
}
