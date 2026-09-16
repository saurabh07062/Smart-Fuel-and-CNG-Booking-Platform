import { uploadUrl } from "@/services/api/apiClient";
import type { User } from "@/types";

/**
 * One place that decides which avatar to show.
 *
 * Order matters and is preserved from js/utils.js#avatarUrl: an uploaded
 * photo on the server beats the legacy data URL that used to live in
 * localStorage, which beats the placeholder. Accounts created before uploads
 * existed still carry the old value, so both have to keep working.
 */
export function avatarUrl(user?: User | null): string {
  return (
    uploadUrl(user?.profileImage) ||
    localStorage.getItem("fm-photo") ||
    "https://picsum.photos/seed/saurabh/40/40.jpg"
  );
}
