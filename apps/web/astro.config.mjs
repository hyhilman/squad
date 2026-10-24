// The web app builds to static files in dist/. `squad web` serves them and the /api routes from one
// origin, so the session cookie is same-origin and the app never holds a token. Every path that is
// not /api, /auth or a built file gets index.html, and React Router takes it from there.
import { defineConfig } from "astro/config";
import react from "@astrojs/react";

export default defineConfig({
  output: "static",
  integrations: [react()],
  server: { host: "127.0.0.1" },
  vite: {
    // The CSP allows only files from the same origin, so no asset may be inlined as a data: URI.
    build: { assetsInlineLimit: 0 },
    server: {
      // In dev, the API comes from a local `squad web --api-only`.
      proxy: { "/api": "http://127.0.0.1:20140", "/auth": "http://127.0.0.1:20140", "/logos": "http://127.0.0.1:20140" },
    },
  },
});
