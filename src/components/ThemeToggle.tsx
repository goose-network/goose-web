// src/components/ThemeToggle.tsx — light / dark / system, persisted.

import { useTheme, type ThemeChoice } from "../theme";
import { IconAuto, IconMoon, IconSun } from "./icons";

const OPTIONS: Array<{ value: ThemeChoice; label: string; Icon: typeof IconSun }> = [
  { value: "light", label: "Light theme", Icon: IconSun },
  { value: "dark", label: "Dark theme", Icon: IconMoon },
  { value: "system", label: "Follow system theme", Icon: IconAuto },
];

export function ThemeToggle() {
  const { choice, setChoice } = useTheme();
  return (
    <div className="theme-toggle" role="group" aria-label="Theme">
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={choice === value}
          onClick={() => setChoice(value)}
        >
          <Icon />
        </button>
      ))}
    </div>
  );
}
