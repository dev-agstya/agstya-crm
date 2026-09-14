import axios, {
  AxiosError,
  AxiosRequestConfig,
  InternalAxiosRequestConfig,
} from "axios";

const BASE = import.meta.env.VITE_API_BASE_URL || "";

export const ACCESS_KEY = "agastya_access";
export const REFRESH_KEY = "agastya_refresh";

export const tokenStore = {
  get access() {
    return localStorage.getItem(ACCESS_KEY);
  },
  get refresh() {
    return localStorage.getItem(REFRESH_KEY);
  },
  set(access: string, refresh: string) {
    localStorage.setItem(ACCESS_KEY, access);
    localStorage.setItem(REFRESH_KEY, refresh);
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

export const api = axios.create({ baseURL: BASE });

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = tokenStore.access;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// --- Refresh-on-401 handling -------------------------------------------------

/*
  Endpoints that must NOT trigger a refresh on 401.

  This used to be the blanket test `url.includes("/api/auth/")`, which also
  caught `/api/auth/me` — the one call the app makes on every boot. So an
  expired access token on startup was never refreshed: the 401 fell through to
  `loadMe`'s catch, which clears the token store, and the user was bounced to
  the login screen holding a perfectly valid 7-day refresh token that had never
  been tried. Access tokens last 3 hours, so that was "the app logs me out
  every time I come back after lunch".

  Only these four are genuinely unrefreshable: /refresh IS the refresh (it would
  recurse), and the other three are pre-auth by definition.
*/
const NO_REFRESH = [
  "/api/auth/login",
  "/api/auth/refresh",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
];

let refreshing: Promise<string | null> | null = null;

async function doRefresh(): Promise<string | null> {
  const refresh = tokenStore.refresh;
  if (!refresh) return null;
  try {
    const res = await axios.post(`${BASE}/api/auth/refresh`, {
      refresh_token: refresh,
    });
    tokenStore.set(res.data.access_token, res.data.refresh_token);
    return res.data.access_token;
  } catch {
    tokenStore.clear();
    return null;
  }
}

api.interceptors.response.use(
  (r) => r,
  async (error: AxiosError) => {
    const original = error.config as AxiosRequestConfig & {
      _retried?: boolean;
    };
    const status = error.response?.status;
    const url = original?.url ?? "";
    const isAuthCall = NO_REFRESH.some((p) => url.includes(p));

    if (status === 401 && !original?._retried && !isAuthCall) {
      original._retried = true;
      // The in-flight refresh is shared so N concurrent 401s cause ONE refresh.
      // Clearing it in `.finally` rather than after the await means it is
      // cleared exactly once, by the call that created it — resetting it in
      // every waiter left a window where a later 401 reused an already-settled
      // promise.
      if (!refreshing) {
        refreshing = doRefresh().finally(() => { refreshing = null; });
      }
      const newToken = await refreshing;
      if (newToken) {
        original.headers = original.headers || {};
        (original.headers as Record<string, string>).Authorization =
          `Bearer ${newToken}`;
        return api(original);
      }
      // Refresh failed — force logout.
      window.dispatchEvent(new CustomEvent("auth:logout"));
    }
    return Promise.reject(error);
  }
);

// Extract a human message from an API error. The backend returns a specific
// `detail` for every handled error (and includes a reference code like
// "ERR-3F9A2C" on unexpected 500s), so we surface that verbatim. The fallbacks
// only apply to transport-level failures where the server never answered.
export function apiError(err: unknown, fallback?: string): string {
  const e = err as AxiosError<{ detail?: string; error_id?: string }>;
  const detail = e?.response?.data?.detail;
  if (typeof detail === "string" && detail.trim()) return detail;
  if (e?.code === "ECONNABORTED")
    return "The request timed out. Please check your connection and try again.";
  if (e?.response == null)
    return "Can't reach the server. Please check your internet connection and "
      + "try again.";
  return fallback
    ?? `Request failed (${e?.response?.status ?? "unknown"}). Please try again.`;
}
