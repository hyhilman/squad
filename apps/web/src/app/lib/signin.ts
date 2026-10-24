// Where a signed-out browser goes. /auth/* is the backend's, not a route of this app: the router
// has no page for it and would render nothing. So the app does a full page load to this URL.
export function signInUrl(pathname: string, search: string): string {
  const here = pathname + search;
  const back = here.startsWith("/") && !here.startsWith("//") && here !== "/" && !pathname.startsWith("/auth") && !here.includes("\\");
  return back ? `/auth/login?to=${encodeURIComponent(here)}` : "/auth/login";
}

export type SignInPlan = { kind: "redirect"; url: string } | { kind: "popup"; url: string };

/**
 * How a signed-out page signs in. A top-level page goes to the sign-in page. Inside a frame that
 * cannot work (the identity server refuses to be framed), so the plain sign-in page opens in a popup;
 * the framed page waits for the session, then closes the popup.
 */
export function signInPlan(w: { readonly top: unknown; readonly self: unknown }, pathname: string, search: string): SignInPlan {
  if (w.top !== null && w.top === w.self) return { kind: "redirect", url: signInUrl(pathname, search) };
  return { kind: "popup", url: "/auth/login" };
}
