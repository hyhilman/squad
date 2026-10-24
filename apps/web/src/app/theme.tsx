// Light or dark follows the system. Ant Design reads the choice through its ConfigProvider.
import { theme as antdTheme, type ThemeConfig } from "antd";
import { useEffect, useState } from "react";

const QUERY = "(prefers-color-scheme: dark)";

export function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia(QUERY).matches);
  useEffect(() => {
    const m = window.matchMedia(QUERY);
    const on = () => setDark(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return dark;
}

// The server puts a fresh nonce in a meta tag and in the page's CSP. Ant Design writes its styles at
// run time and needs that nonce on each <style>, or the CSP blocks them.
export const styleNonce = (): string | undefined => document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content || undefined;

export const themeFor = (dark: boolean): ThemeConfig => ({
  algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
  token: { borderRadius: 6 },
});

/** One color per account, the same in light and dark. The order follows the sorted account list. */
export const PALETTE = ["#4e79d9", "#e8833a", "#3fae6a", "#c64fa0", "#8a6fd6", "#d4b02a", "#2aa7b8", "#d4564c", "#7f8c8d", "#9bbf3a"] as const;
export const colorOf = (i: number): string => PALETTE[i % PALETTE.length]!;
