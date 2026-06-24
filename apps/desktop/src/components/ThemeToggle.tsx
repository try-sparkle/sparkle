import { type CSSProperties, type ComponentType } from "react";
import { TbDeviceDesktop, TbSunFilled, TbMoonFilled } from "react-icons/tb";
import { C, ON_BRAND_FILL } from "../theme/colors";
import { useUiStore, type ThemePref } from "../stores/uiStore";

// Segmented Theme control for the TopBar ⋯ menu: Auto | ☀ | ☾. The selected segment is
// teal-filled; it reads/writes `themePref` from uiStore, which the root's useApplyTheme()
// turns into the live <html data-theme>.
const SEGMENTS: Array<{
  pref: ThemePref;
  label: string;
  Icon: ComponentType<{ size?: number }>;
  aria: string;
}> = [
  { pref: "auto", label: "Auto", Icon: TbDeviceDesktop, aria: "Auto theme (follow the system)" },
  { pref: "light", label: "", Icon: TbSunFilled, aria: "Light theme" },
  { pref: "dark", label: "", Icon: TbMoonFilled, aria: "Dark theme" },
];

const row: CSSProperties = { display: "flex", alignItems: "center", gap: 6 };

const seg: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  padding: "6px 0",
  cursor: "pointer",
  fontSize: 13,
  fontFamily: '"IBM Plex Sans", sans-serif',
};

export function ThemeToggle() {
  const themePref = useUiStore((s) => s.themePref);
  const setThemePref = useUiStore((s) => s.setThemePref);
  return (
    <div role="group" aria-label="Theme" style={row}>
      {SEGMENTS.map(({ pref, label, Icon, aria }) => {
        const selected = themePref === pref;
        return (
          <button
            key={pref}
            type="button"
            aria-label={aria}
            aria-pressed={selected}
            onClick={() => setThemePref(pref)}
            style={{
              ...seg,
              // The labelled "Auto" segment is a touch wider so its text isn't cramped.
              flex: label ? 1.5 : 1,
              background: selected ? C.teal : "transparent",
              // On-teal foreground stays light in both themes (C.cream flips to navy in light).
              color: selected ? ON_BRAND_FILL : C.muted,
              borderColor: selected ? C.teal : C.muted,
            }}
          >
            <Icon size={15} />
            {label && <span>{label}</span>}
          </button>
        );
      })}
    </div>
  );
}
