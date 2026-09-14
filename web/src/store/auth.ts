import { create } from "zustand";
import { authApi } from "../api/endpoints";
import { tokenStore } from "../api/client";
import type { Me } from "../lib/types";

interface AuthState {
  user: Me | null;
  loading: boolean;
  initialized: boolean;
  setUser: (u: Me | null) => void;
  loadMe: () => Promise<void>;
  logout: () => Promise<void>;
  has: (permission: string) => boolean;
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  loading: false,
  initialized: false,

  setUser: (u) => set({ user: u }),

  loadMe: async () => {
    if (!tokenStore.access) {
      set({ user: null, initialized: true });
      return;
    }
    set({ loading: true });
    try {
      const res = await authApi.me();
      set({ user: res.data, initialized: true, loading: false });
    } catch (err) {
      // Only an actual REJECTION of the credentials clears them. This used to
      // be a bare `catch` that cleared on anything, so a cold Render start or a
      // dropped connection — routine on one instance — signed the user out and
      // threw away a refresh token the server had never even seen. A request
      // that got no response tells us nothing about whether we are still
      // signed in, so it must not be treated as a "no".
      const status = (err as { response?: { status?: number } })?.response
        ?.status;
      if (status === 401 || status === 403) tokenStore.clear();
      set({ user: null, initialized: true, loading: false });
    }
  },

  logout: async () => {
    try {
      await authApi.logout();
    } catch {
      /* ignore */
    }
    tokenStore.clear();
    set({ user: null });
  },

  // An owner holds every permission by definition — the same rule canAccess()
  // applies to nav and routes (lib/access.ts). Without this, `has()` answers
  // from the flag list the server happened to store, so a permission added
  // after the owner account was created reads as "no" and hides in-page
  // controls (Add account, Transfer) on a page the owner can plainly open.
  // The server is still the enforcement — this only keeps the UI honest.
  has: (permission) => {
    const user = get().user;
    if (!user) return false;
    if (user.account_type === "owner") return true;
    return user.permissions.includes(permission);
  },
}));
