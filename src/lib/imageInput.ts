/**
 * imageInput — turn a user-selected image file into a payload Claude's vision
 * API will accept.
 *
 * Downscaling is not an optimisation here, it is a correctness requirement:
 * a phone screenshot or a print-resolution cover inflates ~33% when base64
 * encoded and can exceed the API request limit outright. Claude gains no
 * accuracy from images beyond ~1568px on the long edge, and reading a cover's
 * design language needs far less than that, so we re-encode to a bounded JPEG
 * before the bytes ever leave the browser.
 */

/** Long-edge ceiling. Comfortably enough to read palette, type and layout. */
const MAX_EDGE = 1024;
const JPEG_QUALITY = 0.85;

/** Rejected before decode — a guard against pathological uploads, not a UX rule. */
export const MAX_REFERENCE_BYTES = 12 * 1024 * 1024;

export interface ImagePayload {
	/** Always 'image/jpeg' — the canvas re-encode normalises every input. */
	mediaType: string;
	/** Bare base64, no data: URI prefix. */
	data: string;
	/** Object URL for local display. Caller owns revocation. */
	previewUrl: string;
}

/**
 * Read, downscale and base64-encode an image file.
 * @throws Error with a user-facing message on any invalid input.
 */
export async function fileToImagePayload(file: File): Promise<ImagePayload> {
	if (!file.type.startsWith('image/')) {
		throw new Error('That file is not an image. Upload a JPG, PNG or WebP cover.');
	}
	if (file.size > MAX_REFERENCE_BYTES) {
		throw new Error('That image is larger than 12 MB. Please use a smaller file.');
	}

	const bitmap = await loadBitmap(file);

	try {
		const scale  = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
		const width  = Math.max(1, Math.round(bitmap.width  * scale));
		const height = Math.max(1, Math.round(bitmap.height * scale));

		const canvas = document.createElement('canvas');
		canvas.width  = width;
		canvas.height = height;

		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('Could not read that image in this browser.');

		// Flatten onto white — a transparent PNG would otherwise encode its
		// transparent regions as black and misreport the reference's palette.
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, width, height);
		ctx.drawImage(bitmap, 0, 0, width, height);

		const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
		const data    = dataUrl.split(',')[1];
		if (!data) throw new Error('Could not read that image. Try a different file.');

		return { mediaType: 'image/jpeg', data, previewUrl: dataUrl };
	} finally {
		// Only the ImageBitmap path holds a handle worth releasing.
		if ('close' in bitmap) bitmap.close();
	}
}

/** createImageBitmap where available; <img> decode as the fallback path. */
async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
	if (typeof createImageBitmap === 'function') {
		try {
			return await createImageBitmap(file);
		} catch {
			// Fall through — some browsers reject exotic encodings here but
			// still decode them through an <img> element.
		}
	}

	const url = URL.createObjectURL(file);
	try {
		const img = new Image();
		img.src = url;
		await img.decode();
		return img;
	} catch {
		throw new Error('Could not read that image. Try a JPG or PNG.');
	} finally {
		URL.revokeObjectURL(url);
	}
}
