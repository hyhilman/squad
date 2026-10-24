// The look: calm neutral greys, one indigo accent, Inter (bundled, no font from the network).
import { createSystem, defaultConfig, defineConfig } from "@chakra-ui/react";

const SANS = `"Inter Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
const MONO = `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace`;

const config = defineConfig({
  globalCss: {
    "html, body": { bg: "canvas", color: "fg" },
    "html": { colorPalette: "gray" },
  },
  theme: {
    tokens: {
      fonts: { body: { value: SANS }, heading: { value: SANS }, mono: { value: MONO } },
      colors: {
        brand: {
          50: { value: "#eef2ff" }, 100: { value: "#e0e7ff" }, 200: { value: "#c7d2fe" }, 300: { value: "#a5b4fc" },
          400: { value: "#818cf8" }, 500: { value: "#6366f1" }, 600: { value: "#4f46e5" }, 700: { value: "#4338ca" },
          800: { value: "#3730a3" }, 900: { value: "#312e81" }, 950: { value: "#1e1b4b" },
        },
      },
    },
    semanticTokens: {
      colors: {
        // The page, the cards on it, and the sidebar.
        canvas: { value: { _light: "#fafafa", _dark: "#09090b" } },
        surface: { value: { _light: "#ffffff", _dark: "#111113" } },
        sidebar: { value: { _light: "#f4f4f5", _dark: "#0c0c0e" } },
        border: {
          DEFAULT: { value: { _light: "#e4e4e7", _dark: "#232327" } },
          subtle: { value: { _light: "#f0f0f2", _dark: "#1a1a1e" } },
        },
        fg: {
          DEFAULT: { value: { _light: "#18181b", _dark: "#ededef" } },
          muted: { value: { _light: "#63636e", _dark: "#a0a0ab" } },
          subtle: { value: { _light: "#8b8b96", _dark: "#71717a" } },
        },
        brand: {
          contrast: { value: { _light: "white", _dark: "white" } },
          fg: { value: { _light: "{colors.brand.700}", _dark: "{colors.brand.300}" } },
          subtle: { value: { _light: "{colors.brand.50}", _dark: "{colors.brand.950}" } },
          muted: { value: { _light: "{colors.brand.100}", _dark: "{colors.brand.900}" } },
          emphasized: { value: { _light: "{colors.brand.200}", _dark: "{colors.brand.800}" } },
          solid: { value: { _light: "{colors.brand.600}", _dark: "{colors.brand.500}" } },
          focusRing: { value: { _light: "{colors.brand.500}", _dark: "{colors.brand.400}" } },
          border: { value: { _light: "{colors.brand.500}", _dark: "{colors.brand.400}" } },
        },
        // The room bar: the state colours, and the grey of the floor part.
        room: {
          track: { value: { _light: "#ececef", _dark: "#1f1f23" } },
          floor: { value: { _light: "#c4c4cc", _dark: "#46464f" } },
          tick: { value: { _light: "#52525b", _dark: "#a1a1aa" } },
          blue: { value: { _light: "#3b82f6", _dark: "#60a5fa" } },
          yellow: { value: { _light: "#eab308", _dark: "#facc15" } },
          orange: { value: { _light: "#f97316", _dark: "#fb923c" } },
          red: { value: { _light: "#ef4444", _dark: "#f87171" } },
        },
      },
    },
  },
});

export const system = createSystem(defaultConfig, config);
