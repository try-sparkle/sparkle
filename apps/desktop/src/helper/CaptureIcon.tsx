// Approved capture icon: stroke-style camera + lens, with four waveform bars to the right.
// Inline SVG in the react-icons house style — no emoji (founder rule). aria-hidden so the
// button's accessible name stays "Capture". Moved from tray/TrayChrome.tsx unchanged.
export function CaptureIcon() {
  return (
    <svg
      width={18}
      height={14}
      viewBox="0 0 30 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 8a2 2 0 0 1 2-2h1.3l1.2-2h4.6l1.2 2H15a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z" />
      <circle cx="9.5" cy="12.5" r="3" />
      <path d="M20.5 10v5M23 6.5v12M25.5 8.5v8M28 10.5v4" />
    </svg>
  );
}
