// Shared by the server renderer and the browser crop editor so both show the same area.
export const MAX_ZOOM = 3;
export type Crop = { x: number; y: number; zoom: number };
export type Rect = { left: number; top: number; width: number; height: number };

// x and y are the crop center as fractions of the image. At zoom 1 the crop is the
// largest area with the target aspect ratio, which is the same area that a cover fit uses.
export function cropRect(width: number, height: number, targetWidth: number, targetHeight: number, crop: Crop): Rect {
  const aspect = targetWidth / targetHeight;
  const base = width / height > aspect
    ? { width: height * aspect, height }
    : { width, height: width / aspect };
  const cropWidth = base.width / crop.zoom;
  const cropHeight = base.height / crop.zoom;
  const clamp = (center: number, size: number, limit: number) =>
    Math.min(Math.max(center - size / 2, 0), limit - size);
  return {
    left: clamp(crop.x * width, cropWidth, width),
    top: clamp(crop.y * height, cropHeight, height),
    width: cropWidth,
    height: cropHeight
  };
}

// Returns the crop with its center moved so that the crop stays inside the image.
export function clampCrop(width: number, height: number, targetWidth: number, targetHeight: number, crop: Crop): Crop {
  const rect = cropRect(width, height, targetWidth, targetHeight, crop);
  return { x: (rect.left + rect.width / 2) / width, y: (rect.top + rect.height / 2) / height, zoom: crop.zoom };
}
