import sharp, { type Metadata } from 'sharp';
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
export const DIVIDER_WIDTH = 2;
export const PORTRAIT_WIDTH = (WIDTH - DIVIDER_WIDTH) / 2;
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

function isPortrait(metadata: Metadata): boolean {
  if (!metadata.width || !metadata.height) throw new Error('Image dimensions are missing');
  const rotated = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
  return rotated ? metadata.width > metadata.height : metadata.height > metadata.width;
}

async function preparePortraitDecoded(decoded: Buffer) {
  const metadata = await sharp(decoded, { failOn: 'error' }).metadata();
  if (!isPortrait(metadata)) return { portrait: false as const, pairContain: null, pairCover: null };
  const slot = async (fit: Fit) => {
    const pixels = await sharp(decoded, { failOn: 'error' }).rotate()
      .resize(PORTRAIT_WIDTH, HEIGHT, { fit, background: '#000000' })
      .flatten({ background: '#000000' }).toColourspace('srgb').removeAlpha().raw().toBuffer();
    return rgb565Slot(pixels);
  };
  const [pairContain, pairCover] = await Promise.all([slot('contain'), slot('cover')]);
  return { portrait: true as const, pairContain, pairCover };
}

function rgb565Slot(rgb: Uint8Array): Buffer {
  if (rgb.length !== PORTRAIT_WIDTH * HEIGHT * 3) throw new Error('Wrong portrait image size');
  const result = Buffer.alloc(PORTRAIT_WIDTH * HEIGHT * 2);
  for (let src = 0, dst = 0; src < rgb.length; src += 3, dst += 2) {
    const pixel = ((rgb[src] >> 3) << 11) | ((rgb[src + 1] >> 2) << 5) | (rgb[src + 2] >> 3);
    result.writeUInt16LE(pixel, dst);
  }
  return result;
}

export function combinePortraits(left: Buffer, right: Buffer): Buffer {
  const rowBytes = PORTRAIT_WIDTH * 2;
  if (left.length !== rowBytes * HEIGHT || right.length !== rowBytes * HEIGHT) {
    throw new Error('Wrong portrait image size');
  }
  const result = Buffer.alloc(FRAME_BYTES);
  for (let row = 0; row < HEIGHT; row++) {
    const sourceOffset = row * rowBytes;
    const targetOffset = row * WIDTH * 2;
    left.copy(result, targetOffset, sourceOffset, sourceOffset + rowBytes);
    result.writeUInt16LE(0x0000, targetOffset + rowBytes);
    result.writeUInt16LE(0x0000, targetOffset + rowBytes + 2);
    right.copy(result, targetOffset + rowBytes + DIVIDER_WIDTH * 2, sourceOffset, sourceOffset + rowBytes);
  }
  return result;
}

export async function prepare(original: Buffer, fit: Fit) {
  return prepareDecoded(await decodeHeif(original), fit);
}

export async function preparePortrait(original: Buffer) {
  return preparePortraitDecoded(await decodeHeif(original));
}

export async function prepareBoth(original: Buffer) {
  const decoded = await decodeHeif(original);
  const [contain, cover, portrait] = await Promise.all([
    prepareDecoded(decoded, 'contain'),
    prepareDecoded(decoded, 'cover'),
    preparePortraitDecoded(decoded)
  ]);
  return {
    contain,
    cover,
    ...portrait
  };
}
