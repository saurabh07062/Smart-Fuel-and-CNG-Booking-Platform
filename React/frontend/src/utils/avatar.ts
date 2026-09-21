import { uploadUrl } from "@/services/api/apiClient";
import type { User } from "@/types";

/** "Saurabh Yadav" -> "SY", "saurabh" -> "S", nothing -> "?". */
export function initialsOf(name?: string | null): string {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "";
  return (first + last).toUpperCase();
}

/** A round image of the initials on FuelMart red, usable anywhere an <img> src is. */
export function initialsAvatar(name?: string | null): string {
  const text = initialsOf(name).replace(/[<>&"']/g, "");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80">` +
    `<rect width="80" height="80" rx="40" fill="#E23744"/>` +
    `<text x="40" y="41" text-anchor="middle" dominant-baseline="central" font-family="Inter,Arial,sans-serif" ` +
    `font-size="32" font-weight="700" fill="#ffffff">${text}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Which avatar to show: the uploaded photo, else the legacy data URL some
 * older accounts still keep in localStorage, else the person's initials.
 */
export function avatarUrl(user?: User | null): string {
  let legacy: string | null = null;
  try {
    legacy = localStorage.getItem("fm-photo");
  } catch {
    /* no storage */
  }
  return uploadUrl(user?.profileImage) || legacy || initialsAvatar(user?.name);
}
