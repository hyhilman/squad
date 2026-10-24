// The full-screen wait: the same logo and line as the page's first paint (src/styles/loader.css), so
// the step from the page's loader to the app's is not seen. In-page loads use skeletons instead.
import { Text } from "@chakra-ui/react";
import { BrandLogo } from "./BrandLogo.tsx";

export function LogoLoader({ text = "Loading squad…" }: { text?: string }) {
  return (
    <div className="squad-loader" role="status" aria-live="polite">
      <BrandLogo size="96px" className="squad-loader-logo" />
      <Text fontSize="14px" color="fg.muted" m="0">
        {text}
      </Text>
    </div>
  );
}

/** Fades out the page's own loader once the app has drawn. With reduced motion it goes at once. */
export function hidePageLoader(): void {
  const el = document.getElementById("squad-loader");
  if (el === null) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return el.remove();
  el.classList.add("squad-loader-out");
  el.addEventListener("transitionend", () => el.remove(), { once: true });
  // A tab in the background may never fire transitionend.
  setTimeout(() => el.remove(), 600);
}
