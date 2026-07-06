// Web port of apps/mobile/src/components/KindIcon.tsx — monochrome Feather-style glyph tinted by
// status color. build→pickaxe, think→bulb, worker→corner-down-right, shell→terminal.
// The build pickaxe paths are kept byte-for-byte identical to apps/mobile/src/components/KindIcon.tsx
// (Lucide "pickaxe") so the desktop tray and mobile roster render the exact same glyph — keep them
// in sync if either changes.
export function TrayKindIcon({ kind, color, size = 17 }: { kind: string; color: string; size?: number }) {
  const stroke = color || "#8aa0c4";
  const common = { stroke, strokeWidth: 2, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      {kind === "think" ? (
        <>
          <path d="M12 3a6 6 0 0 0-3.6 10.8c.5.4.6.9.6 1.4v.3h6v-.3c0-.5.1-1 .6-1.4A6 6 0 0 0 12 3z" {...common} />
          <path d="M9.5 18.5h5 M10.5 21h3" {...common} />
        </>
      ) : kind === "worker" ? (
        <path d="M15 10l5 5-5 5 M4 4v7a4 4 0 0 0 4 4h12" {...common} />
      ) : kind === "shell" ? (
        <path d="M4 17l6-6-6-6 M12 19h8" {...common} />
      ) : (
        // build → pickaxe (Lucide "pickaxe") — kept in sync with apps/mobile/src/components/KindIcon.tsx
        <>
          <path d="M14.531 12.469 6.619 20.38a1 1 0 1 1-3-3l7.912-7.912" {...common} />
          <path d="M15.686 4.314A12.5 12.5 0 0 0 5.461 2.958 1 1 0 0 0 5.58 4.71a22 22 0 0 1 6.318 3.393" {...common} />
          <path d="M17.7 3.7a1 1 0 0 0-1.4 0l-4.6 4.6a1 1 0 0 0 0 1.4l2.6 2.6a1 1 0 0 0 1.4 0l4.6-4.6a1 1 0 0 0 0-1.4z" {...common} />
          <path d="M19.686 8.314a12.501 12.501 0 0 1 1.356 10.225 1 1 0 0 1-1.751-.119 22 22 0 0 0-3.393-6.319" {...common} />
        </>
      )}
    </svg>
  );
}
