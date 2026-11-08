// Traitement des images envoyées : orientation corrigée, métadonnées supprimées (EXIF, GPS…), vignette.
import sharp from 'sharp';

sharp.cache(false);
sharp.concurrency(1);
const LIMIT_PIXELS = 100_000_000; // refuse les images « bombes » de plus de 100 mégapixels

export interface ProcessedImage {
  buf: Buffer;
  thumb: Buffer;
}

export async function processImage(input: Buffer, mime: string): Promise<ProcessedImage> {
  const animated = mime === 'image/gif' || mime === 'image/webp';
  const base = () => sharp(input, { animated, limitInputPixels: LIMIT_PIXELS, failOn: 'error' });
  // sharp n'écrit aucune métadonnée en sortie, sauf demande explicite : l'EXIF (dont la position GPS) disparaît.
  let pipeline = base().rotate();
  switch (mime) {
    case 'image/jpeg':
      pipeline = pipeline.jpeg({ quality: 92, mozjpeg: true });
      break;
    case 'image/png':
      pipeline = pipeline.png({ compressionLevel: 9 });
      break;
    case 'image/webp':
      pipeline = pipeline.webp({ quality: 90 });
      break;
    case 'image/gif':
      pipeline = pipeline.gif();
      break;
    case 'image/avif':
      pipeline = pipeline.avif({ quality: 60 });
      break;
    default:
      throw new Error('type d’image non pris en charge');
  }
  const buf = await pipeline.toBuffer();
  const thumb = await sharp(input, { limitInputPixels: LIMIT_PIXELS, failOn: 'error' })
    .rotate()
    .resize(320, 320, { fit: 'cover', position: 'attention' })
    .webp({ quality: 75 })
    .toBuffer();
  return { buf, thumb };
}
