import { useEffect, useRef, useState } from "react";
import { useAuthStore } from "@/store/authStore";
import { uploadMyProfileImage, removeMyProfileImage } from "@/services/api/authApi";
import { toApiError, uploadUrl } from "@/services/api/apiClient";
import { imageFileProblem, IMAGE_MAX_BYTES } from "@/utils/imageUpload";
import { initialsAvatar } from "@/utils/avatar";
import { pushToast } from "@/store/toastStore";

/**
 * The avatar in the console header -- and the place the photo is changed.
 *
 * Two things this fixes about the plain <img> it replaces:
 *
 *   1. A stored path that no longer resolves rendered as the browser's broken
 *      image icon. It now falls back to the initials, which is what an account
 *      without a photo shows anyway, so a missing file looks like no photo
 *      rather than like a broken page.
 *
 *   2. There was nowhere to set the photo from. The corner avatar is where
 *      people look for it, so clicking it opens the picker directly, with
 *      Remove beside it once there is something to remove.
 *
 * Shared by the admin and vendor consoles (both render ConsoleShell). It writes
 * the SIGNED-IN account only -- the server takes the id from the session and
 * ignores anything in the request that names a user (backend routes/authRoutes.js).
 */
export default function ConsoleAvatar() {
  const user = useAuthStore((s) => s.user);
  const patchUser = useAuthStore((s) => s.patchUser);

  const fileInput = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [broken, setBroken] = useState(false);

  const stored = uploadUrl(user?.profileImage ?? null);
  const photo = broken ? null : stored;

  // A new upload replaces the src, so give it a fresh chance to load.
  useEffect(() => setBroken(false), [user?.profileImage]);

  // Close the little menu on a click elsewhere or on Escape, the way every
  // other menu in the console behaves.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const choose = async (file: File | undefined) => {
    if (!file) return;
    // Checked here so the answer is immediate; the server checks again.
    const problem = imageFileProblem(file);
    if (problem) {
      pushToast(problem, "error");
      return;
    }
    setBusy(true);
    setMenuOpen(false);
    try {
      const saved = await uploadMyProfileImage(file);
      if (!saved) throw new Error("The server did not return the saved photo.");
      patchUser({ profileImage: saved });
      pushToast("Profile photo updated", "success");
    } catch (err) {
      pushToast(err instanceof Error && !("response" in err) ? err.message : toApiError(err).msg, "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setMenuOpen(false);
    try {
      await removeMyProfileImage();
      patchUser({ profileImage: null });
      pushToast("Profile photo removed", "success");
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="vm-avatar-wrap" ref={wrapRef}>
      <button
        type="button"
        className="vm-avatar-btn"
        onClick={() => (photo ? setMenuOpen((open) => !open) : fileInput.current?.click())}
        disabled={busy}
        aria-haspopup={photo ? "menu" : undefined}
        aria-expanded={photo ? menuOpen : undefined}
        aria-label={photo ? "Change or remove your profile photo" : "Add a profile photo"}
        title={photo ? "Change your photo" : "Add a photo"}
        data-testid="console-avatar"
      >
        <img
          src={photo || initialsAvatar(user?.name)}
          alt=""
          className="vm-avatar"
          onError={() => setBroken(true)}
        />
        <span className="vm-avatar-edit" aria-hidden>
          <i className={`fas ${busy ? "fa-spinner fa-spin" : "fa-camera"}`} />
        </span>
      </button>

      {menuOpen && photo && (
        <div className="vm-avatar-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => fileInput.current?.click()}>
            <i className="fas fa-arrows-rotate" aria-hidden /> Change photo
          </button>
          <button type="button" role="menuitem" className="is-danger" onClick={() => void remove()}>
            <i className="fas fa-trash" aria-hidden /> Remove photo
          </button>
        </div>
      )}

      <input
        ref={fileInput}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        aria-label="Choose a profile photo"
        title={`JPG, PNG or WEBP, up to ${Math.round(IMAGE_MAX_BYTES / (1024 * 1024))}MB`}
        onChange={(e) => {
          void choose(e.target.files?.[0]);
          e.target.value = ""; // choosing the same file again still fires
        }}
      />
    </div>
  );
}
