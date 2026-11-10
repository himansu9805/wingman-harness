// Remove the old browser-stored token when upgrading to environment configuration.
/** Remove the obsolete browser-stored connection credentials when storage is available. */
export function removeLegacyConnection() {
  try {
    localStorage.removeItem("wingman.connection");
  } catch {
    /* No browser storage. */
  }
}
/** Read the saved conversation ID, returning null when storage is unavailable. */
export function selectedThread(): string | null {
  try {
    return localStorage.getItem("wingman.thread");
  } catch {
    return null;
  }
}
/** Persist or clear the selected conversation without failing when storage is unavailable. */
export function saveThread(id: string | null) {
  try {
    if (id) localStorage.setItem("wingman.thread", id);
    else localStorage.removeItem("wingman.thread");
  } catch {
    /* Browsing still works without storage. */
  }
}
