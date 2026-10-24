// Remove the old browser-stored token when upgrading to environment configuration.
export function removeLegacyConnection() {
  try { localStorage.removeItem('wingman.connection'); } catch { /* No browser storage. */ }
}
export function selectedThread(): string | null {
  try { return localStorage.getItem('wingman.thread'); } catch { return null; }
}
export function saveThread(id: string | null) {
  try { if (id) localStorage.setItem('wingman.thread', id); else localStorage.removeItem('wingman.thread'); } catch { /* Browsing still works without storage. */ }
}
