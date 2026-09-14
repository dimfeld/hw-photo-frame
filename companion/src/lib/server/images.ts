import sharp from 'sharp';
export const WIDTH = 1024;
export const HEIGHT = 600;
export const FRAME_BYTES = WIDTH * HEIGHT * 2;
export type Fit = 'contain' | 'cover';

export function rgb565(rgb: Uint8Array): Buffer {
  if (rgb.length !== WIDTH * HEIGHT * 3) throw new Error('Wrong RGB image size');
  const result = Buffer.alloc(FRAME_BYTES);
  for (let src = 0, dst = 0; src < rgb.length; src += 3, dst += 2) {
    const pixel = ((rgb[src] >> 3) << 11) | ((rgb[src + 1] >> 2) << 5) | (rgb[src + 2] >> 3);
    result.writeUInt16LE(pixel, dst);
  }
  return result;
}

export async function prepare(original: Buffer, fit: Fit) {
  // Sharp applies EXIF orientation before it fits the photo to the panel.
  const pixels = await sharp(original, { failOn: 'error' }).rotate()
    .resize(WIDTH, HEIGHT, { fit, background: '#000000' })
    .flatten({ background: '#000000' }).toColourspace('srgb').removeAlpha().raw().toBuffer();
  const preview = await sharp(pixels, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } }).jpeg().toBuffer();
  return { pixels: rgb565(pixels), preview };
}
