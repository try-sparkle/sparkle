import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { FiRefreshCw, FiSmartphone } from "react-icons/fi";
import { C, DANGER } from "../theme/colors";
import { FONT_WEIGHT } from "@sparkle/ui";
import {
  listPairedDevices,
  mintPairCode,
  revokePairedDevice,
  type PairedDevice,
} from "../services/sparkleApi";

// Settings → Mobile pane: the paired-device registry (list + per-device unpair) and the
// "Pair a new device" flow (6-char code, 15-min TTL, countdown + regenerate). All network I/O
// happens in Rust (auth.rs) — this component only invokes the Tauri commands via sparkleApi.
//
// Degradation contract (spec §C / rollout): the relay device-registry endpoints may not be
// deployed yet. The Rust layer maps a 404 to the stable "devices_unsupported" string; we render
// that as a calm "relay update pending" state, never a crash. Pairing itself (POST /pair/code)
// predates the registry and keeps working either way.

/** Pair-code TTL, mirroring the relay's 15-minute expiry. The relay only returns the code, so
 *  the countdown is anchored client-side at mint time — close enough for a UX hint.
 *  Exported for the expiry test, which must advance time past this exact value. */
export const CODE_TTL_MS = 15 * 60 * 1000;

/** Rust rejections are raw strings; JS-side throws are Errors. Render both without the
 *  "Error: " prefix so every failure path reads the same. */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type DevicesState =
  | { kind: "loading" }
  | { kind: "unsupported" }
  | { kind: "error"; message: string }
  | { kind: "ready"; devices: PairedDevice[] };

export function MobileDevicesPane() {
  const [state, setState] = useState<DevicesState>({ kind: "loading" });
  // Ticks once a minute so "last seen" stays honest while the pane sits open, and once a second
  // while a pair code is showing (the countdown). One clock serves both.
  const [now, setNow] = useState(() => Date.now());

  // Pairing flow: no code yet → code showing (countdown) → expired (regenerate).
  const [code, setCode] = useState<string | null>(null);
  const [codeMintedAt, setCodeMintedAt] = useState(0);
  const [minting, setMinting] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);

  // Per-row unpair: which row shows the inline confirm, which rows are mid-revoke (a Set —
  // concurrent revokes of different rows must not clobber each other's in-flight marker).
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [revokingIds, setRevokingIds] = useState<ReadonlySet<string>>(new Set());
  const [revokeError, setRevokeError] = useState<string | null>(null);

  // Monotonic epoch so overlapping refreshes (post-revoke + manual click) can't resolve out
  // of order and paint a stale list or error over the newer result.
  const refreshEpoch = useRef(0);
  const refresh = useCallback(async () => {
    const epoch = ++refreshEpoch.current;
    setState({ kind: "loading" });
    setRevokeError(null);
    setConfirmId(null);
    try {
      const devices = await listPairedDevices();
      if (epoch !== refreshEpoch.current) return;
      setState({ kind: "ready", devices });
    } catch (e) {
      if (epoch !== refreshEpoch.current) return;
      // Exact match: the Rust side rejects with this precise string (auth.rs
      // DEVICES_UNSUPPORTED); a substring test could hide a real failure that echoes it.
      const message = errorMessage(e);
      setState(message === "devices_unsupported" ? { kind: "unsupported" } : { kind: "error", message });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const codeRemainingMs = code ? Math.max(0, codeMintedAt + CODE_TTL_MS - now) : 0;
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), code && codeRemainingMs > 0 ? 1000 : 60_000);
    return () => clearInterval(id);
  }, [code, codeRemainingMs > 0]);

  const mint = async () => {
    setMinting(true);
    setPairError(null);
    try {
      const c = await mintPairCode();
      setCode(c);
      setCodeMintedAt(Date.now());
      setNow(Date.now());
    } catch (e) {
      setPairError(`Couldn't get a pairing code: ${String(e)}`);
    } finally {
      setMinting(false);
    }
  };

  const revoke = async (id: string) => {
    setRevokingIds((cur) => new Set(cur).add(id));
    setRevokeError(null);
    try {
      await revokePairedDevice(id);
      setConfirmId(null);
      await refresh();
    } catch (e) {
      setRevokeError(`Unpair failed: ${errorMessage(e)}`);
    } finally {
      setRevokingIds((cur) => {
        const next = new Set(cur);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* ── Pair a new device ─────────────────────────────────────────────── */}
      <div>
        <div style={subLabel}>Pair a new device</div>
        <div style={panel}>
          {code ? (
            <>
              <div data-testid="pair-code" style={codeStyle}>
                {code}
              </div>
              <div style={hint}>
                {codeRemainingMs > 0 ? (
                  <>
                    Code expires in{" "}
                    <span style={{ fontVariantNumeric: "tabular-nums", color: C.cream }}>
                      {formatCountdown(codeRemainingMs)}
                    </span>
                  </>
                ) : (
                  "This code has expired — generate a new one."
                )}
              </div>
              <div style={hint}>
                Install the Sparkle app on your phone and enter this code at sign-in.
              </div>
              <button type="button" style={actionBtn} onClick={() => void mint()} disabled={minting}>
                <FiRefreshCw size={13} />
                {minting ? "Generating…" : "New code"}
              </button>
            </>
          ) : (
            <>
              <div style={hint}>
                Install the Sparkle app on your phone, then enter a one-time code at sign-in to
                pair it with this Mac.
              </div>
              <button type="button" style={actionBtn} onClick={() => void mint()} disabled={minting}>
                <FiSmartphone size={13} />
                {minting ? "Generating…" : "Get pairing code"}
              </button>
            </>
          )}
          {pairError && <div style={errorText}>{pairError}</div>}
        </div>
      </div>

      {/* ── Paired devices ────────────────────────────────────────────────── */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <div style={{ ...subLabel, marginBottom: 0 }}>Paired devices</div>
          {(state.kind === "ready" || state.kind === "unsupported") && (
            <button
              type="button"
              aria-label="Refresh device list"
              title="Refresh"
              style={iconBtn}
              onClick={() => void refresh()}
            >
              <FiRefreshCw size={13} />
            </button>
          )}
        </div>
        <DeviceList
          state={state}
          now={now}
          confirmId={confirmId}
          revokingIds={revokingIds}
          onConfirm={setConfirmId}
          onRevoke={(id) => void revoke(id)}
          onRetry={() => void refresh()}
        />
        {revokeError && <div style={errorText}>{revokeError}</div>}
      </div>
    </div>
  );
}

function DeviceList({
  state,
  now,
  confirmId,
  revokingIds,
  onConfirm,
  onRevoke,
  onRetry,
}: {
  state: DevicesState;
  now: number;
  confirmId: string | null;
  revokingIds: ReadonlySet<string>;
  onConfirm: (id: string | null) => void;
  onRevoke: (id: string) => void;
  onRetry: () => void;
}) {
  switch (state.kind) {
    case "loading":
      return <div style={{ ...panel, ...hint }}>Loading devices…</div>;
    case "unsupported":
      return (
        <div style={{ ...panel, ...hint }}>
          No devices yet — the device list needs a Sparkle relay update that hasn't rolled out.
          Pairing still works; devices will appear here once the relay is updated.
        </div>
      );
    case "error":
      return (
        <div style={panel}>
          <div style={errorText}>Couldn't load devices: {state.message}</div>
          <button type="button" style={actionBtn} onClick={onRetry}>
            <FiRefreshCw size={13} />
            Retry
          </button>
        </div>
      );
    case "ready":
      if (state.devices.length === 0) {
        return (
          <div style={{ ...panel, ...hint }}>
            No devices paired yet. Pair your phone with a code above — it will show up here.
          </div>
        );
      }
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {state.devices.map((d) => (
            <DeviceRow
              key={d.id}
              device={d}
              now={now}
              confirming={confirmId === d.id}
              revoking={revokingIds.has(d.id)}
              onConfirm={onConfirm}
              onRevoke={onRevoke}
            />
          ))}
        </div>
      );
  }
}

function DeviceRow({
  device,
  now,
  confirming,
  revoking,
  onConfirm,
  onRevoke,
}: {
  device: PairedDevice;
  now: number;
  confirming: boolean;
  revoking: boolean;
  onConfirm: (id: string | null) => void;
  onRevoke: (id: string) => void;
}) {
  return (
    <div style={deviceRow}>
      <FiSmartphone size={16} style={{ flex: "none", color: C.muted }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={deviceName}>
          <span style={deviceNameText}>{device.name || "Unknown device"}</span>
          {device.current && <span style={currentBadge}>This Mac</span>}
        </div>
        <div style={deviceMeta}>
          {platformLabel(device.platform)} · Paired {formatDate(device.createdAt)} · Last seen{" "}
          {relativeTime(device.lastSeenAt, now)}
        </div>
      </div>
      {/* Unpairing the CURRENT device would revoke this Mac's own token and silently sign the
          app out — the phone-side "Unpair" (DELETE /devices/me → signOut) owns that flow. */}
      {!device.current &&
        (confirming ? (
          <div style={{ display: "flex", gap: 6, flex: "none" }}>
            <button
              type="button"
              style={{ ...smallBtn, color: DANGER, borderColor: DANGER }}
              onClick={() => onRevoke(device.id)}
              disabled={revoking}
            >
              {revoking ? "Unpairing…" : "Unpair"}
            </button>
            <button type="button" style={smallBtn} onClick={() => onConfirm(null)} disabled={revoking}>
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" style={{ ...smallBtn, flex: "none" }} onClick={() => onConfirm(device.id)}>
            Unpair…
          </button>
        ))}
    </div>
  );
}

// ── formatting helpers ───────────────────────────────────────────────────────

function formatCountdown(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function platformLabel(platform: string): string {
  const p = (platform || "").toLowerCase();
  if (p === "ios") return "iPhone";
  if (p === "android") return "Android";
  if (p === "desktop" || p === "macos" || p === "mac") return "Mac";
  return platform || "Unknown platform";
}

function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "recently";
  return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Coarse relative time for "last seen" — falls back to the absolute date past ~30 days. */
function relativeTime(iso: string | null | undefined, now: number): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "unknown";
  const mins = Math.floor(Math.max(0, now - t) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return days === 1 ? "yesterday" : `${days} days ago`;
  return formatDate(iso);
}

// ── styles (inline CSSProperties, matching SettingsDialog's convention) ──────

const subLabel: CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 1,
  color: C.muted,
  fontWeight: FONT_WEIGHT.semibold,
  marginBottom: 8,
};

const panel: CSSProperties = {
  background: C.forest,
  border: `1px solid ${C.forest}`,
  borderRadius: 9,
  padding: "14px 16px",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  alignItems: "flex-start",
};

const codeStyle: CSSProperties = {
  fontSize: 42,
  fontWeight: FONT_WEIGHT.semibold,
  letterSpacing: 12,
  color: C.cream,
  fontFamily: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  fontVariantNumeric: "tabular-nums",
  alignSelf: "center",
  // Re-center the glyphs: letterSpacing adds a trailing gap after the last character.
  paddingLeft: 12,
  userSelect: "text",
};

const hint: CSSProperties = {
  fontSize: 12,
  color: C.muted,
  lineHeight: 1.5,
};

const errorText: CSSProperties = {
  fontSize: 12,
  color: DANGER,
  lineHeight: 1.5,
  marginTop: 6,
};

const actionBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  background: "transparent",
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: 8,
  padding: "7px 12px",
  cursor: "pointer",
  fontSize: 13,
  fontFamily: '"IBM Plex Sans", sans-serif',
};

const iconBtn: CSSProperties = {
  display: "grid",
  placeItems: "center",
  background: "transparent",
  border: "none",
  color: C.muted,
  cursor: "pointer",
  padding: 4,
  borderRadius: 6,
};

const deviceRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  background: C.forest,
  borderRadius: 9,
  padding: "11px 14px",
};

const deviceName: CSSProperties = {
  fontSize: 13,
  color: C.cream,
  fontWeight: FONT_WEIGHT.medium,
  display: "flex",
  alignItems: "center",
  gap: 8,
  minWidth: 0,
};

// Ellipsis must live on a non-flex child — textOverflow has no effect on a flex container,
// and without this a long device name pushes the badge/buttons out of the row.
const deviceNameText: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

const currentBadge: CSSProperties = {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: C.accentInk,
  border: `1px solid ${C.accentInk}`,
  borderRadius: 5,
  padding: "1px 6px",
  flex: "none",
};

const deviceMeta: CSSProperties = {
  fontSize: 11.5,
  color: C.muted,
  marginTop: 2,
};

const smallBtn: CSSProperties = {
  background: "transparent",
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: 7,
  padding: "5px 10px",
  cursor: "pointer",
  fontSize: 12,
  fontFamily: '"IBM Plex Sans", sans-serif',
};
