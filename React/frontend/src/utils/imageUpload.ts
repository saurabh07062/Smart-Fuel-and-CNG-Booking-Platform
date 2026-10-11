/**
 * The image rules the server enforces on every photo upload (backend
 * middleware/upload.js): JPG, PNG or WEBP by both MIME type and extension,
 * 5MB for station and vendor photos. Checked here first so a wrong file is
 * refused with a clear message before it is sent.
 */
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const IMAGE_ACCEPT = IMAGE_TYPES.join(",");
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Why a chosen file cannot be uploaded, or null. */
export function imageFileProblem(file: File, maxBytes = IMAGE_MAX_BYTES): string | null {
  if (!IMAGE_TYPES.includes(file.type) || !/\.(jpe?g|png|webp)$/i.test(file.name)) {
    return `"${file.name}" is not a JPG, PNG or WEBP image.`;
  }
  if (file.size > maxBytes) return `"${file.name}" is larger than ${Math.round(maxBytes / (1024 * 1024))}MB.`;
  return null;
}

/**
 * What the picture itself has to be, for a station or pump photo. The same
 * numbers the server enforces (backend services/upload/imageRules.js): a
 * landscape photo big enough for the customer's banner, so an upload cannot
 * end up stretched across it.
 */
export const STATION_IMAGE_RULES = {
  minWidth: 800,
  minHeight: 450,
  maxWidth: 8000,
  maxHeight: 8000,
  minRatio: 1.2,
  maxRatio: 2.6,
} as const;

/** One line a vendor can read before choosing a file. */
export const STATION_IMAGE_RULE_TEXT =
  "JPG, PNG or WEBP · at least 800 × 450 px · landscape (between 1.2:1 and 2.6:1) · up to 5MB";

/**
 * Type, size AND dimensions. Reading the dimensions needs the browser to
 * decode the file, so this is async; the type and size checks stay
 * synchronous in imageFileProblem() for callers that only need those.
 *
 * The server checks all of it again. This exists so a vendor is told what is
 * wrong immediately, instead of after a 4MB upload.
 */
export async function stationImageProblem(file: File, maxBytes = IMAGE_MAX_BYTES): Promise<string | null> {
  const basic = imageFileProblem(file, maxBytes);
  if (basic) return basic;

  const size = await readImageDimensions(file);
  // The browser could not decode it. That is not proof the file is bad --
  // the server reads the header itself and refuses it there -- so the vendor
  // is not blocked on a guess.
  if (!size) return null;

  const r = STATION_IMAGE_RULES;
  const { width, height } = size;
  if (width < r.minWidth || height < r.minHeight) {
    return `That photo is ${width}×${height}. It must be at least ${r.minWidth}×${r.minHeight} pixels.`;
  }
  if (width > r.maxWidth || height > r.maxHeight) {
    return `That photo is ${width}×${height}, larger than ${r.maxWidth}×${r.maxHeight}. Resize it first.`;
  }
  const ratio = width / height;
  if (ratio < r.minRatio) return `That photo is portrait (${width}×${height}). Upload a landscape photo.`;
  if (ratio > r.maxRatio) return `That photo is too wide (${width}×${height}). Upload a landscape photo.`;
  return null;
}

/** Pixel size of a chosen file, or null when the browser cannot decode it. */
export function readImageDimensions(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}
