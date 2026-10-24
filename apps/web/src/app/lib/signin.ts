// Signed out, the app never moves by itself: it shows a card with a Sign in button, and only the
// button goes to the backend's sign-in. Going there on its own would sign a person straight back in
// right after Sign out, since the identity provider still knows them.
import { AUTH_PATHS, SIGNED_OUT_PATH, SIGNED_OUT_SQUAD_ONLY } from "@squad/contract";
import { inFrame } from "./embed.ts";

/**
 * Where the Sign in button sends a top-level page. /auth/* is the backend's, not a route of this
 * app: the router has no page for it, so the button does a full page load. The current path comes
 * back after sign-in, unless it is a sign-in or signed-out path.
 */
export function signInUrl(pathname: string, search: string): string {
  const here = pathname + search;
  const back = here.startsWith("/") && !here.startsWith("//") && here !== "/" && !pathname.startsWith("/auth") && pathname !== SIGNED_OUT_PATH && !here.includes("\\");
  return back ? `${AUTH_PATHS.login}?to=${encodeURIComponent(here)}` : AUTH_PATHS.login;
}

export type SignInPlan = { kind: "redirect"; url: string } | { kind: "popup"; url: string };

/**
 * What the Sign in button does. A top-level page goes to the sign-in page. Inside a frame that cannot
 * work (the identity server refuses to be framed), so the plain sign-in page opens in a popup; the
 * framed page waits for the session, then closes the popup.
 */
export function signInPlan(w: { readonly top: unknown; readonly self: unknown }, pathname: string, search: string): SignInPlan {
  if (!inFrame(w)) return { kind: "redirect", url: signInUrl(pathname, search) };
  return { kind: "popup", url: AUTH_PATHS.login };
}

/** What the signed-out card adds: the person signed out, or signed out of squad only. None after a session ran out. */
export function signedOutNote(pathname: string, search: string): "signed-out" | "squad-only" | undefined {
  if (pathname !== SIGNED_OUT_PATH) return undefined;
  return new URLSearchParams(search).toString() === SIGNED_OUT_SQUAD_ONLY ? "squad-only" : "signed-out";
}
