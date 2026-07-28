// Where a torn-out project window LANDS.
//
// This is the part of the feature that is about multiple monitors, and it is the part that cannot
// be checked by running the app on one screen. Every case below is a real multi-display arrangement
// — a second monitor to the right, above, to the LEFT (negative origin, the arrangement people
// forget), and a display unplugged since the drag began.
//
// The composition being tested is exactly the one `tearOffTopLeft`'s doc mandates: centre on the
// cursor, choose the display from the CENTRE via `hitTestPoint(..., fresh: true, ...)`, then clamp.
// Skipping the middle step is not a cosmetic bug — it puts the window on the wrong monitor.
import { describe, it, expect } from "vitest";
import { satellitePosition } from "./ProjectTabsBar";
import { SATELLITE_SIZE } from "../services/satelliteWindows";
import type { Rect } from "../helper/helperGeometry";

const W = SATELLITE_SIZE.width;
const H = SATELLITE_SIZE.height;

/** A 1920×1080 laptop screen at the origin. */
const PRIMARY: Rect = { x: 0, y: 0, width: 1920, height: 1080 };
/** A 2560×1440 display to its RIGHT. */
const RIGHT: Rect = { x: 1920, y: 0, width: 2560, height: 1440 };
/** …and one to its LEFT, so the origin is negative — the case that breaks any code assuming (0,0). */
const LEFT: Rect = { x: -2560, y: 0, width: 2560, height: 1440 };

describe("satellitePosition", () => {
  it("centres the window on the drop point", () => {
    const at = { x: 900, y: 600 };
    expect(satellitePosition(at, [PRIMARY])).toEqual({ x: 900 - W / 2, y: 600 - H / 2 });
  });

  it("keeps a window dropped on the SECOND monitor on the second monitor", () => {
    // Dead centre of the right-hand display. The whole feature is this case.
    const pos = satellitePosition({ x: 3200, y: 720 }, [PRIMARY, RIGHT]);
    expect(pos.x).toBeGreaterThanOrEqual(RIGHT.x);
    expect(pos.x + W).toBeLessThanOrEqual(RIGHT.x + RIGHT.width);
    expect(pos.y).toBeGreaterThanOrEqual(RIGHT.y);
    expect(pos.y + H).toBeLessThanOrEqual(RIGHT.y + RIGHT.height);
  });

  it("does not yank a window back to the primary when dropped near a second monitor's left edge", () => {
    // x = 1960 is 40px into the right-hand display. The naive top-left is 1960 - 500 = 1460, which
    // lies on the PRIMARY — so choosing the display from the top-left instead of the centre would
    // clamp this onto the wrong screen. That regression is invisible on a single-monitor machine.
    const pos = satellitePosition({ x: 1960, y: 700 }, [PRIMARY, RIGHT]);
    expect(pos.x).toBeGreaterThanOrEqual(RIGHT.x);
  });

  it("handles a monitor at a NEGATIVE origin", () => {
    const pos = satellitePosition({ x: -1280, y: 700 }, [PRIMARY, LEFT]);
    expect(pos.x).toBeGreaterThanOrEqual(LEFT.x);
    expect(pos.x + W).toBeLessThanOrEqual(LEFT.x + LEFT.width);
  });

  it("pulls a window dropped at a screen corner fully back on-screen", () => {
    // Released at the very bottom-right pixel: centring would hang most of the window off both
    // edges, so the clamp has to bring it back.
    const pos = satellitePosition({ x: 1919, y: 1079 }, [PRIMARY]);
    expect(pos).toEqual({ x: PRIMARY.width - W, y: PRIMARY.height - H });
  });

  it("falls back to the first display when the drop point is on none", () => {
    // The monitor the drag started over was unplugged before release — `screenFor`'s documented
    // fallback. The window must still appear somewhere the user can see it.
    const pos = satellitePosition({ x: 9000, y: 9000 }, [PRIMARY]);
    expect(pos).toEqual({ x: PRIMARY.width - W, y: PRIMARY.height - H });
  });

  it("degrades to the origin rather than throwing when there are no monitors at all", () => {
    // No Tauri (dev preview) or a failed monitor query. A bad position is recoverable; a throw
    // here would abort the tear-off with the ownership claim already written.
    expect(satellitePosition({ x: 900, y: 600 }, [])).toEqual({ x: 0, y: 0 });
  });
});
