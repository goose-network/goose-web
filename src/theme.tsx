// src/theme.tsx — light/dark/system theme selection.
//
// The palette in palette.css keys off `data-theme` on <html>: pinned values
// override, and with the attribute absent the OS preference wins. This
// provider owns that attribute and persists the reader's choice, so dark
// mode is reachable from the UI instead of only from the OS.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ThemeChoice = "light" | "dark" | "system";

const STORAGE_KEY = "goose-web.theme";

function loadChoice(): ThemeChoice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
    // Older builds stored a JSON string; accept it rather than ignoring it.
    const parsed: unknown = JSON.parse(raw ?? "null");
    if (parsed === "light" || parsed === "dark") return parsed;
  } catch {
    // corrupted or unavailable storage; fall through to the default
  }
  return "system";
}

interface ThemeContextValue {
  /** what the reader chose */
  choice: ThemeChoice;
  /** what is actually painted right now */
  effective: "light" | "dark";
  setChoice: (c: ThemeChoice) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(loadChoice);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  // Follow OS changes while the choice is "system".
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const effective: "light" | "dark" =
    choice === "system" ? (systemDark ? "dark" : "light") : choice;

  useEffect(() => {
    const root = document.documentElement;
    if (choice === "system") delete root.dataset.theme;
    else root.dataset.theme = choice;
  }, [choice]);

  const setChoice = useCallback((c: ThemeChoice) => {
    setChoiceState(c);
    try {
      localStorage.setItem(STORAGE_KEY, c);
    } catch {
      // storage unavailable; the choice just won't persist
    }
  }, []);

  const value = useMemo(
    () => ({ choice, effective, setChoice }),
    [choice, effective, setChoice],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const v = useContext(ThemeContext);
  if (v === null) throw new Error("useTheme must be used inside <ThemeProvider>");
  return v;
}
