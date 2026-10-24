// Where a signed-out browser goes. /auth/* is the backend's, not a route of this app: the router
// has no page for it and would render nothing. So the app does a full page load to this URL.
export function signInUrl(pathname: string, search: string): string {
  const here = pathname + search;
  const back = here.startsWith("/") && !here.startsWith("//") && here !== "/" && !pathname.startsWith("/auth") && !here.includes("\\");
  return back ? `/auth/login?to=${encodeURIComponent(here)}` : "/auth/login";
}
