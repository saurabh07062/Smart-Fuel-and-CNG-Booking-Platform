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
