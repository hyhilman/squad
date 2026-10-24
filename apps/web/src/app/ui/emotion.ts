// Chakra writes its styles at run time through Emotion. The server sends a strict CSP with a fresh
// nonce per page, in <meta name="csp-nonce">; every <style> Emotion adds must carry it, or the
// browser drops the styles.
import createCache from "@emotion/cache";

const nonce = typeof document === "undefined" ? undefined : document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content || undefined;

export const emotionCache = createCache({ key: "css", ...(nonce === undefined ? {} : { nonce }) });
