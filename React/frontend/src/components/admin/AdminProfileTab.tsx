import { useRef, useState } from "react";
import { useAuthStore } from "@/store/authStore";
import { uploadMyProfileImage, removeMyProfileImage } from "@/services/api/authApi";
import { toApiError, uploadUrl } from "@/services/api/apiClient";
import { imageFileProblem, IMAGE_MAX_BYTES } from "@/utils/imageUpload";
import { initialsAvatar } from "@/utils/avatar";
import { pushToast } from "@/store/toastStore";

/**
 * The admin's own account: their photo, and what the platform holds about them.
 *
 * WHY A PHOTO AT ALL
 *
 * Until now only customers and vendors could set one, so every admin showed as
 * the initials block -- including in the support conversations they answer,
 * where a face is the difference between "someone from FuelMart" and an
 * anonymous reply. The upload writes the SIGNED-IN account and no other: the
 * server takes the id from the session, never from the request
 * (backend routes/authRoutes.js).
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * No role field, no permissions, no other admin's account. An admin changing
 * their own role, or editing a colleague's, is not an account-settings action --
 * it is an access-control change, and it does not belong behind a photo picker.
 */
export default function AdminProfileTab() {
  const user = useAuthStore((s) => s.user);
  const patchUser = useAuthStore((s) => s.patchUser);

  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);

  const stored = uploadUrl(user?.profileImage ?? null);
  const photo = broken ? null : stored;

  const choose = async (file: File | undefined) => {
    if (!file) return;
    // Checked here so the admin is told immediately rather than after the
    // upload; the server checks the same things again (middleware/upload.js).
    const problem = imageFileProblem(file);
    setError(problem);
    if (problem) return;

    setBusy(true);
    try {
      const saved = await uploadMyProfileImage(file);
      if (!saved) throw new Error("The server did not return the saved photo.");
      // The console header reads the auth store, so this updates the avatar in
      // the corner at the same moment.
      patchUser({ profileImage: saved });
      setBroken(false);
      pushToast("Profile photo updated", "success");
    } catch (err) {
      const msg = err instanceof Error && !("response" in err) ? err.message : toApiError(err).msg;
      setError(msg);
      pushToast(msg, "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await removeMyProfileImage();
      patchUser({ profileImage: null });
      pushToast("Profile photo removed", "success");
    } catch (err) {
      const msg = toApiError(err).msg;
      setError(msg);
      pushToast(msg, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="vm-stat-value" style={{ fontSize: 22 }}>
          My Profile
        </h2>
        <p className="vm-text-muted text-sm mt-1">
          Your own account. The photo appears in the console header and beside your replies in
          support conversations.
        </p>
      </div>

      <div className="vm-bg-surface rounded-2xl border vm-border p-6" role="region" aria-label="Profile photo">
        <h3 className="text-lg font-bold mb-1 flex items-center gap-2">
          <i className="fas fa-user-circle vm-accent-text" aria-hidden /> Profile Photo
        </h3>
        <p className="vm-subtitle mb-5" style={{ fontSize: 12 }}>
          JPG, PNG or WEBP · up to {Math.round(IMAGE_MAX_BYTES / (1024 * 1024))}MB
        </p>

        <div className="flex flex-wrap items-center gap-5">
          <img
            src={photo || initialsAvatar(user?.name)}
            alt={photo ? "Your profile photo" : "Your initials"}
            width={96}
            height={96}
            className="rounded-full object-cover"
            style={{ width: 96, height: 96, border: "1px solid var(--z-line)" }}
            // A stored path that no longer resolves falls back to the initials
            // rather than showing a broken image.
            onError={() => setBroken(true)}
          />

          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                disabled={busy}
                className="vm-accent vm-accent-hover vm-text font-bold py-2.5 px-4 rounded-lg transition-colors text-sm flex items-center gap-2 disabled:opacity-50"
              >
                <i className={`fas ${busy ? "fa-spinner fa-spin" : photo ? "fa-arrows-rotate" : "fa-upload"}`} aria-hidden />
                {busy ? "Uploading…" : photo ? "Replace photo" : "Upload photo"}
              </button>

              {photo && (
                <button
                  type="button"
                  onClick={() => void remove()}
                  disabled={busy}
                  className="vm-bg-ground vm-hover border vm-border vm-text font-bold py-2.5 px-4 rounded-lg transition-colors text-sm disabled:opacity-50"
                >
                  <i className="fas fa-trash mr-1.5" aria-hidden /> Remove
                </button>
              )}
            </div>
            <p className="text-[11.5px] vm-text-muted">
              {photo ? "Shown wherever your account appears." : "Without a photo your initials are shown."}
            </p>
          </div>

          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            aria-label="Choose a profile photo"
            onChange={(e) => {
              void choose(e.target.files?.[0]);
              e.target.value = ""; // choosing the same file again still fires
            }}
          />
        </div>

        {error && (
          <p role="alert" className="text-xs mt-4" style={{ color: "var(--status-bad)" }}>
            <i className="fas fa-triangle-exclamation mr-1" aria-hidden /> {error}
          </p>
        )}
      </div>

      <div className="vm-bg-surface rounded-2xl border vm-border p-6" role="region" aria-label="Account details">
        <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
          <i className="fas fa-id-badge vm-accent-text" aria-hidden /> Account
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Detail label="Name" value={user?.name} />
          <Detail label="Email" value={user?.email} />
          <Detail label="Role" value={user?.role} />
        </div>
        <p className="text-[11.5px] vm-text-muted mt-4">
          <i className="fas fa-circle-info mr-1" aria-hidden />
          Roles and access are not changed here.
        </p>
      </div>
    </div>
  );
}

/** One read-only fact, or an honest note that it is not recorded. */
function Detail({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <p className="text-[10.5px] font-bold uppercase tracking-wide vm-text-muted">{label}</p>
      {value ? (
        <p className="text-sm font-bold vm-text mt-1" style={{ overflowWrap: "anywhere" }}>
          {value}
        </p>
      ) : (
        <p className="text-sm vm-text-muted mt-1 italic">Not recorded</p>
      )}
    </div>
  );
}
