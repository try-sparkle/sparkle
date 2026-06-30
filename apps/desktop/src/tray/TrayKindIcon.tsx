// Web port of apps/mobile/src/components/KindIcon.tsx — monochrome Feather-style glyph tinted by
// status color. build→tool, think→bulb, worker→corner-down-right, shell→terminal.
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
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" {...common} />
      )}
    </svg>
  );
}
