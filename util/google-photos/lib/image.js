import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

// Keep in sync with util/resizeImages/resizeImages.js, which applies the same
// limit to images already committed to the repo.
const MAX_DIMENSION = 2048;

/**
 * Converts an image buffer to a JPEG and writes it into destDir, using preferredName's
 * basename (extension swapped to .jpg). If a file with the same basename (ignoring
 * extension/case) already exists in destDir, it's replaced in place -- this doubles as
 * a repair path for photos that were previously saved without EXIF metadata.
 */
export async function saveAsJpeg(buffer, destDir, preferredName) {
	fs.mkdirSync(destDir, { recursive: true });

	const baseName = path.parse(preferredName || 'photo').name || 'photo';
	const existing = fs
		.readdirSync(destDir)
		.find((f) => path.parse(f).name.toLowerCase() === baseName.toLowerCase());
	const destPath = existing ? path.join(destDir, existing) : path.join(destDir, `${baseName}.jpg`);

	const jpegBuffer = await sharp(buffer, { failOn: 'none' })
		.rotate() // apply EXIF orientation, then strip the tag
		.resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
		.withMetadata() // keep the rest of EXIF (e.g. capture date)
		.jpeg({ quality: 92 })
		.toBuffer();

	fs.writeFileSync(destPath, jpegBuffer);
	return { destPath, replaced: Boolean(existing) };
}
