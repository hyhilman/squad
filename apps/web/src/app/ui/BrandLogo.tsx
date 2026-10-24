// squad's logo for the current theme: navy robots on light, colour robots on dark. Both images are in
// the page and the root's theme class shows one, so a theme change shows the other at once, with no
// fetch. The files sit at /brand/, so an operator's SQUAD_WEB_BRAND_DIR replaces them with no new build.
import { Image } from "@chakra-ui/react";

export function BrandLogo({ size }: { size: number | string }) {
  return (
    <>
      <Image src="/brand/logo-light.png" alt="" boxSize={size} flexShrink={0} draggable={false} _dark={{ display: "none" }} />
      <Image src="/brand/logo-dark.png" alt="" boxSize={size} flexShrink={0} draggable={false} display="none" _dark={{ display: "block" }} />
    </>
  );
}
