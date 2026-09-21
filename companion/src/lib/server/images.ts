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
export const DIVIDER_WIDTH = 2;
export const PORTRAIT_WIDTH = (WIDTH - DIVIDER_WIDTH) / 2;
export type Fit = 'contain' | 'cover';

export function isJpeg(input: Uint8Array): boolean {
  return input.length >= 4 && input[0] === 0xff && input[1] === 0xd8
    && input[input.length - 2] === 0xff && input[input.length - 1] === 0xd9;
}

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

async function prepareDecoded(original: Buffer, fit: Fit) {
  // Sharp applies EXIF orientation before it fits the photo to the panel.
  return sharp(original, { failOn: 'error' }).rotate()
    .resize(WIDTH, HEIGHT, { fit, background: '#000000' })
    .flatten({ background: '#000000' }).toColourspace('srgb').removeAlpha()
    .jpeg({ progressive: false }).toBuffer();
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
    return sharp(decoded, { failOn: 'error' }).rotate()
      .resize(PORTRAIT_WIDTH, HEIGHT, { fit, background: '#000000' })
      .flatten({ background: '#000000' }).toColourspace('srgb').removeAlpha()
      .jpeg({ progressive: false }).toBuffer();
  };
  const [pairContain, pairCover] = await Promise.all([slot('contain'), slot('cover')]);
  return { portrait: true as const, pairContain, pairCover };
}

export async function combinePortraits(left: Buffer, right: Buffer): Promise<Buffer> {
  return sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: '#000000' } })
    .composite([
      { input: left, left: 0, top: 0 },
      { input: right, left: PORTRAIT_WIDTH + DIVIDER_WIDTH, top: 0 }
    ])
    .jpeg({ progressive: false }).toBuffer();
}

export async function prepare(original: Buffer, fit: Fit) {
  return prepareDecoded(await decodeHeif(original), fit);
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
