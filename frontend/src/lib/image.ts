// Resize + center-crop an uploaded image to a small square JPEG data URL, so avatars stay tiny
// (~15–30 KB) and fit well within the upload route's size cap. Runs entirely in the browser.
export async function resizeImageToDataUrl(file: File, size = 256, quality = 0.85): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const min = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - min) / 2;
    const sy = (bitmap.height - min) / 2;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas не поддерживается');
    ctx.drawImage(bitmap, sx, sy, min, min, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    bitmap.close?.();
  }
}
