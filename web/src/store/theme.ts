// Dark mode was removed (owner decision) — the app is light-only. Importing this
// module clears any previously persisted "dark" preference and ensures the root
// element never carries the `dark` class, so returning users who had dark saved
// land on the light theme. There is no theme toggle anymore.

const STORAGE_KEY = "crm.theme";

try {
  localStorage.removeItem(STORAGE_KEY);
} catch {
  /* localStorage may be unavailable (private mode) — ignore */
}

document.documentElement.classList.remove("dark");
