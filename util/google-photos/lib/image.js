import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

/**
 * Converts an image buffer to a JPEG and writes it into destDir, using preferredName's
 * basename (extension swapped to .jpg). Avoids overwriting existing files by suffixing
 * -2, -3, etc.
 */
export async function saveAsJpeg(buffer, destDir, preferredName) {
	fs.mkdirSync(destDir, { recursive: true });

	const baseName = path.parse(preferredName || 'photo').name || 'photo';
	let destPath = path.join(destDir, `${baseName}.jpg`);
	let counter = 2;
	while (fs.existsSync(destPath)) {
		destPath = path.join(destDir, `${baseName}-${counter}.jpg`);
		counter += 1;
	}

	const jpegBuffer = await sharp(buffer, { failOn: 'none' })
		.rotate() // apply EXIF orientation, then strip the tag
		.jpeg({ quality: 92 })
		.toBuffer();

	fs.writeFileSync(destPath, jpegBuffer);
	return destPath;
}
