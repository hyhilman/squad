// Sign-in is the backend's OIDC flow (code flow with PKCE against the configured identity server). The app only sends the
// browser to /auth/login and asks /api/me who is signed in. It never sees a token.
import type { AuthProvider } from "@refinedev/core";
import { ApiFailure } from "@squad/contract";
import { api } from "./api.ts";

export const authProvider: AuthProvider = {
  login: async () => {
    window.location.assign("/auth/login");
    return { success: true };
  },
  logout: async () => {
    // /auth is outside the contract; the backend wants the same csrf proof as for a write.
    await fetch("/auth/logout", { method: "POST", headers: { "x-squad-csrf": "1" }, credentials: "same-origin" });
    window.location.assign("/");
    return { success: true };
  },
  check: async () => {
    try {
      await api("me", {});
      return { authenticated: true };
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 401) return { authenticated: false, redirectTo: "/auth/login" };
      throw e;
    }
  },
  getIdentity: async () => api("me", {}),
  onError: async (error: unknown) => (error instanceof ApiFailure && error.status === 401 ? { logout: true } : {}),
};
