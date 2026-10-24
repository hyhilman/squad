// Light or dark. The default follows the system; a choice is kept in this browser. Not next-themes:
// it adds an inline script, which the CSP blocks.
import { useEffect, useState, useSyncExternalStore } from "react";

export type ThemeChoice = "system" | "light" | "dark";
const KEY = "squad-theme";
const QUERY = "(prefers-color-scheme: dark)";

function readChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

const systemDark = (): boolean => window.matchMedia(QUERY).matches;

function apply(choice: ThemeChoice): "light" | "dark" {
  const mode = choice === "system" ? (systemDark() ? "dark" : "light") : choice;
  const root = document.documentElement;
  root.classList.toggle("dark", mode === "dark");
  root.classList.toggle("light", mode === "light");
  root.style.colorScheme = mode;
  return mode;
}

// Before the first paint, so the page does not flash light.
if (typeof document !== "undefined") apply(readChoice());

const subscribe = (cb: () => void) => {
  const m = window.matchMedia(QUERY);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};

export function useColorMode(): { choice: ThemeChoice; mode: "light" | "dark"; setChoice: (c: ThemeChoice) => void } {
  const [choice, setChoiceState] = useState<ThemeChoice>(readChoice);
  const sysDark = useSyncExternalStore(subscribe, systemDark);
  const mode = choice === "system" ? (sysDark ? "dark" : "light") : choice;
  useEffect(() => {
    apply(choice);
  }, [choice, sysDark]);
  const setChoice = (c: ThemeChoice) => {
    try {
      if (c === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, c);
    } catch {
      // No storage (a private window): the choice lasts for this page only.
    }
    setChoiceState(c);
    window.dispatchEvent(new Event("squad-theme"));
  };
  // Other users of the hook (the charts) follow a change made in the sidebar.
  useEffect(() => {
    const on = () => setChoiceState(readChoice());
    window.addEventListener("squad-theme", on);
    return () => window.removeEventListener("squad-theme", on);
  }, []);
  return { choice, mode, setChoice };
}
