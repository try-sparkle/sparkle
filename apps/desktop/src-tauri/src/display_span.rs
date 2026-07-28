//! Span the Sparkle window across every attached display.
//!
//! macOS cannot merge displays into one logical monitor. The closest real behavior is a unified
//! desktop (Mission Control → "Displays have separate Spaces" OFF) with a single window straddling
//! every screen. This module computes the rectangle that window should occupy and applies it.
//!
//! THE WHOLE PROBLEM IS THAT DISPLAYS DON'T UNION INTO A RECTANGLE. A Retina laptop panel flanked
//! by two 1080p externals has three different work-area heights, so the union bounding box includes
//! regions no display covers. A window sized to that box draws part of its UI into those dead
//! zones: rendered by the app, shown by nothing, unclickable. Hence two modes —
//!
//!   - [`SpanMode::Safe`] — the largest rectangle every pixel of which lands on some display.
//!   - [`SpanMode::Full`] — the literal union bounding box, dead corners accepted.
//!
//! EVERYTHING HERE IS IN LOGICAL POINTS, NOT PHYSICAL PIXELS, and that is not a style choice —
//! "physical pixels" is not a coherent global coordinate space on a mixed-DPI Mac.
//!
//! tao derives a monitor's physical rect from its logical CGDisplayBounds times THAT MONITOR's
//! `backingScaleFactor` (`macos/monitor.rs`: `PhysicalPosition::from_logical(bounds.origin,
//! self.scale_factor())`), while window geometry is converted using THE WINDOW's scale factor
//! (`macos/window.rs`: `set_outer_position` does `position.to_logical(self.scale_factor())`).
//! Union a 2× built-in with a 1× external in "physical" and the two disagree about what an x
//! coordinate means: a 2× panel 1512 points wide reports 3024, the 1× external reports its points
//! unchanged, and a window told to go to physical x=4944 lands at less than half the intended
//! offset. Converting each monitor by its OWN scale factor first recovers the single global point
//! space macOS actually uses, which is also the space `LogicalPosition`/`LogicalSize` address.
//!
//! Work AREAS, not full monitor bounds: macOS clamps a normal-level window below the menu bar
//! regardless of what we ask for (see the same note in capture_window.rs), so the work area is the
//! only rect a window can actually fill.
//!
//! ON VERIFYING THAT A SPAN LANDED — DON'T, at least not synchronously. Two commits tried to
//! return the window's real geometry and compare it against the target. It cannot work from a sync
//! command: tao dispatches both setters to the main queue (`set_frame_top_left_point_async`,
//! `set_content_size_async`), and a `#[tauri::command]` without `async` runs ON that main thread,
//! so the queued frame change cannot execute until the command returns. The read-back therefore
//! reports the PRE-span geometry, the comparison is false on every successful span, and the
//! "window is spanned" flag it feeds stays false forever — which silently disables auto-respan.
//! That regression shipped twice. The flag is set on a successful CALL instead; the cost is that a
//! later manual resize leaves it stale, which is recoverable and far less bad than a dead feature.

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Monitor, PhysicalPosition, PhysicalSize,
};

/// Event emitted when the set of attached displays changes. The frontend re-applies the current
/// span when the user has "Re-span when displays change" on.
pub const DISPLAYS_CHANGED_EVENT: &str = "displays-changed";

/// How often the watcher re-reads the monitor list. Display changes are human-scale events
/// (plugging a cable, waking from sleep), so this is deliberately unhurried.
const WATCH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

/// An axis-aligned rectangle in LOGICAL POINTS — the single global coordinate space macOS uses,
/// NOT physical pixels. See the module header: physical pixels are per-monitor on a mixed-DPI Mac
/// and cannot be compared across displays. Every value carried by this type — monitor bounds, work
/// areas, both span targets, and what the pane renders — is points.
///
/// Deliberately a plain data type rather than Tauri's `PhysicalRect`: the geometry below is the
/// part worth testing, and it must be testable without a running app or a windowing backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    // Edges are i64 so no intermediate can overflow. `x` is i32 and `width` is u32, so `x + width`
    // does not fit i32 in general, and the obvious `self.x.saturating_add(self.width as i32)` is
    // WORSE than it looks: `width as i32` is a wrapping cast, so a width past i32::MAX silently
    // becomes negative and `right()` lands to the LEFT of `left()`. Widening instead of casting
    // removes the failure mode rather than guarding it.
    fn left(&self) -> i64 {
        self.x as i64
    }
    fn top(&self) -> i64 {
        self.y as i64
    }
    fn right(&self) -> i64 {
        self.x as i64 + self.width as i64
    }
    fn bottom(&self) -> i64 {
        self.y as i64 + self.height as i64
    }

    /// Is this rect usable as geometry — non-degenerate, and within the coordinate space the window
    /// server actually addresses?
    ///
    /// The upper bound is not paranoia about real monitors (no display is two billion pixels wide);
    /// it is what lets everything downstream stay total. A rect that fails this is dropped rather
    /// than clamped, because a bogus monitor should not silently contribute a bogus span.
    fn is_usable(&self) -> bool {
        self.width > 0
            && self.height > 0
            && self.width <= i32::MAX as u32
            && self.height <= i32::MAX as u32
    }
}

/// Clamp an i64 edge back into the i32 origin space a `Rect` stores.
fn to_origin(value: i64) -> i32 {
    value.clamp(i32::MIN as i64, i32::MAX as i64) as i32
}

/// Clamp an i64 extent back into the u32 dimension space a `Rect` stores.
fn to_extent(value: i64) -> u32 {
    value.clamp(0, u32::MAX as i64) as u32
}

/// Which rectangle "span all displays" should target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SpanMode {
    /// Largest fully-covered rectangle. Loses a band; never hides UI.
    ///
    /// The default, and deliberately the conservative one: a `Full` span on a ragged arrangement
    /// puts UI in regions no display shows, which reads as the app being broken.
    #[default]
    Safe,
    /// Union bounding box. Maximum area; dead corners where displays don't reach.
    Full,
}

/// The union bounding box of `rects` — the smallest rectangle containing all of them.
///
/// `None` for an empty input or one holding only degenerate rects, so callers can't accidentally
/// resize a window to nothing.
pub fn union_rect(rects: &[Rect]) -> Option<Rect> {
    let live: Vec<&Rect> = rects.iter().filter(|r| r.is_usable()).collect();
    let first = live.first()?;
    let mut left = first.left();
    let mut top = first.top();
    let mut right = first.right();
    let mut bottom = first.bottom();
    for r in &live[1..] {
        left = left.min(r.left());
        top = top.min(r.top());
        right = right.max(r.right());
        bottom = bottom.max(r.bottom());
    }
    Some(Rect {
        x: to_origin(left),
        y: to_origin(top),
        width: to_extent(right - left),
        height: to_extent(bottom - top),
    })
}

/// The largest axis-aligned rectangle entirely contained in the union of `rects`.
///
/// Works by decomposing the plane into the grid induced by every input edge:
///
///   1. Collect distinct x edges (lefts and rights) and y edges (tops and bottoms). Between two
///      consecutive edges nothing changes, so each grid CELL is either wholly covered by some rect
///      or wholly uncovered — the continuous problem becomes a finite one with no loss.
///   2. Mark each cell covered if any rect contains it.
///   3. Take the largest all-covered aligned block of cells, measured in real pixels (cells have
///      unequal sizes, so cell COUNT is not area).
///
/// Step 3 is brute force over all `O(nx² · ny²)` blocks with a 2-D prefix sum of uncovered cells
/// giving an O(1) emptiness test. With `n` displays there are at most `2n` edges per axis, so even
/// eight monitors is ~14k trivial checks — instant, and far easier to be confident in than a
/// stack-based maximal-rectangle scan.
///
/// An earlier version tried a cheaper reduction: scan horizontal bands delimited by y edges and,
/// for each, merge the x-intervals of the rects spanning that whole band. That is WRONG for
/// vertically stacked displays — two 1920×1080 monitors one above the other fully cover a
/// 1920×2160 rectangle, but neither one spans the full band, so the merge found nothing and the
/// safe rect collapsed to a single monitor. `vertically_stacked_displays_stay_contiguous_in_safe_mode`
/// is that regression.
pub fn safe_rect(rects: &[Rect]) -> Option<Rect> {
    let live: Vec<&Rect> = rects.iter().filter(|r| r.is_usable()).collect();
    if live.is_empty() {
        return None;
    }

    // `is_usable` guarantees width/height >= 1, so every rect contributes two DISTINCT edges per
    // axis and both vectors have length >= 2 — meaning `nx`/`ny` are always >= 1 below and the
    // subtraction cannot underflow. It also guarantees at least one covered cell exists (a rect
    // covers its own), so `best` is always `Some` here. `safe_rect_is_present_whenever_union_is`
    // holds that invariant: Safe mode must never hard-error on an arrangement Full mode accepts.
    let mut xs: Vec<i64> = live.iter().flat_map(|r| [r.left(), r.right()]).collect();
    xs.sort_unstable();
    xs.dedup();
    let mut ys: Vec<i64> = live.iter().flat_map(|r| [r.top(), r.bottom()]).collect();
    ys.sort_unstable();
    ys.dedup();

    let nx = xs.len() - 1;
    let ny = ys.len() - 1;

    // uncovered[row][col], then folded into a prefix sum so any block's uncovered count is O(1).
    // Dimensions are (ny + 1) × (nx + 1) so index 0 is the zero row/column and no bounds special-
    // casing is needed below.
    let mut prefix = vec![vec![0u32; nx + 1]; ny + 1];
    for row in 0..ny {
        for col in 0..nx {
            let covered = live.iter().any(|r| {
                r.left() <= xs[col]
                    && r.right() >= xs[col + 1]
                    && r.top() <= ys[row]
                    && r.bottom() >= ys[row + 1]
            });
            let uncovered = u32::from(!covered);
            prefix[row + 1][col + 1] =
                uncovered + prefix[row][col + 1] + prefix[row + 1][col] - prefix[row][col];
        }
    }

    let uncovered_in = |col1: usize, row1: usize, col2: usize, row2: usize| -> u32 {
        prefix[row2][col2] + prefix[row1][col1] - prefix[row1][col2] - prefix[row2][col1]
    };

    let mut best: Option<Rect> = None;
    let mut best_area: i128 = 0;

    for row1 in 0..ny {
        for row2 in (row1 + 1)..=ny {
            let height = ys[row2] - ys[row1];
            for col1 in 0..nx {
                for col2 in (col1 + 1)..=nx {
                    if uncovered_in(col1, row1, col2, row2) != 0 {
                        continue;
                    }
                    let width = xs[col2] - xs[col1];
                    // i128 so the product cannot overflow even at the clamped extremes; the
                    // comparison is the only thing it is used for.
                    let area = width as i128 * height as i128;
                    if area > best_area {
                        best_area = area;
                        best = Some(Rect {
                            x: to_origin(xs[col1]),
                            y: to_origin(ys[row1]),
                            width: to_extent(width),
                            height: to_extent(height),
                        });
                    }
                }
            }
        }
    }

    best
}

/// Pick the rect for a span mode. Separated from the commands so the choice is unit-testable.
pub fn span_target(rects: &[Rect], mode: SpanMode) -> Option<Rect> {
    match mode {
        SpanMode::Safe => safe_rect(rects),
        SpanMode::Full => union_rect(rects),
    }
}

/// One attached display, as reported to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct DisplayInfo {
    pub name: Option<String>,
    /// Full monitor bounds.
    pub bounds: Rect,
    /// The rect a window can actually occupy (excludes menu bar / Dock).
    pub work_area: Rect,
    pub scale_factor: f64,
}

/// Everything the Appearance pane needs to render the Window group in one round trip.
#[derive(Debug, Clone, Serialize)]
pub struct DisplayLayout {
    pub displays: Vec<DisplayInfo>,
    /// Union bounding box of the work areas (the `Full` target). `None` if no displays reported.
    pub full: Option<Rect>,
    /// Largest fully-covered rectangle (the `Safe` target). `None` if no displays reported.
    pub safe: Option<Rect>,
    /// macOS: false when "Displays have separate Spaces" is ON, which makes spanning IMPOSSIBLE —
    /// the OS will not let a window cross the boundary. Surfaced so the pane can explain why the
    /// action is unavailable instead of offering a button that silently does nothing.
    /// Always true off macOS, where the setting does not exist.
    pub spanning_enabled: bool,
}

/// Convert one monitor-space physical rect into the global LOGICAL point space, using that
/// monitor's own scale factor — the inverse of how tao produced it. See the module header for why
/// mixing monitor-physical coordinates across displays is meaningless.
fn to_logical_rect(position: PhysicalPosition<i32>, size: PhysicalSize<u32>, scale: f64) -> Rect {
    // A non-positive/NaN scale would poison every coordinate; 1.0 is the identity tao itself falls
    // back to when it cannot find the screen.
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    Rect {
        x: (position.x as f64 / scale).round() as i32,
        y: (position.y as f64 / scale).round() as i32,
        width: (size.width as f64 / scale).round() as u32,
        height: (size.height as f64 / scale).round() as u32,
    }
}

fn describe(monitor: &Monitor) -> DisplayInfo {
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    DisplayInfo {
        name: monitor.name().cloned(),
        bounds: to_logical_rect(*monitor.position(), *monitor.size(), scale),
        work_area: to_logical_rect(area.position, area.size, scale),
        scale_factor: scale,
    }
}

/// Is macOS's unified-desktop mode on? Reads the same preference the Mission Control checkbox
/// writes: `com.apple.spaces spans-displays` is 1 when "Displays have separate Spaces" is OFF.
///
/// An absent key is the factory default — separate Spaces ON — so an unreadable/missing value must
/// read as "spanning unavailable", never as available. A read failure is treated the same way: it
/// is better to explain a precondition that might already be met than to offer a button that
/// cannot work.
/// Cached for the process lifetime, which is exactly as long as the answer can stay valid: the
/// Mission Control setting only takes effect after a log out and back in, and that restarts this
/// process. Without the cache every `display_layout` spawns a subprocess — and `display_layout`
/// runs on pane mount AND on every `displays-changed` event, so a monitor flapping would fork
/// `defaults` once per flap, synchronously, on a command thread.
#[cfg(target_os = "macos")]
static SPANNING_ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

#[cfg(target_os = "macos")]
fn spanning_enabled() -> bool {
    *SPANNING_ENABLED.get_or_init(|| {
        std::process::Command::new("defaults")
            .args(["read", "com.apple.spaces", "spans-displays"])
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).trim() == "1")
            .unwrap_or(false)
    })
}

#[cfg(not(target_os = "macos"))]
fn spanning_enabled() -> bool {
    true
}

fn work_areas(monitors: &[Monitor]) -> Vec<Rect> {
    monitors
        .iter()
        .map(|m| {
            let area = m.work_area();
            to_logical_rect(area.position, area.size, m.scale_factor())
        })
        .collect()
}

/// Read the current display arrangement and both candidate span rectangles.
#[tauri::command]
pub fn display_layout(window: tauri::WebviewWindow) -> Result<DisplayLayout, String> {
    let monitors = window
        .available_monitors()
        .map_err(|e| format!("read monitors: {e}"))?;
    let areas = work_areas(&monitors);
    Ok(DisplayLayout {
        displays: monitors.iter().map(describe).collect(),
        full: union_rect(&areas),
        safe: safe_rect(&areas),
        spanning_enabled: spanning_enabled(),
    })
}

/// Size and position the CALLING window to span every display, per `mode`.
///
/// Targets the calling window rather than a hardcoded "main" label so a project window spans
/// itself rather than yanking the main window around behind the user's back.
#[tauri::command]
pub fn span_window(window: tauri::WebviewWindow, mode: SpanMode) -> Result<Rect, String> {
    let monitors = window
        .available_monitors()
        .map_err(|e| format!("read monitors: {e}"))?;
    let areas = work_areas(&monitors);
    let target = span_target(&areas, mode).ok_or_else(|| "no displays reported".to_string())?;
    apply(&window, target)
}

/// Fit the calling window to the work area of the display it is currently on.
#[tauri::command]
pub fn fit_window_to_current_display(window: tauri::WebviewWindow) -> Result<Rect, String> {
    let monitor = window
        .current_monitor()
        .map_err(|e| format!("read current monitor: {e}"))?
        .or(window
            .primary_monitor()
            .map_err(|e| format!("read primary monitor: {e}"))?)
        .ok_or_else(|| "no displays reported".to_string())?;
    let area = monitor.work_area();
    apply(
        &window,
        to_logical_rect(area.position, area.size, monitor.scale_factor()),
    )
}

/// Restore the calling window to its default size, centered on the primary display. The recovery
/// path: a window spanned across displays that are no longer attached can land somewhere with no
/// grabbable title bar, and this is the way back without touching System Settings.
#[tauri::command]
pub fn reset_window_size(window: tauri::WebviewWindow) -> Result<Rect, String> {
    window
        .set_size(LogicalSize::new(DEFAULT_WIDTH, DEFAULT_HEIGHT))
        .map_err(|e| format!("set size: {e}"))?;
    window.center().map_err(|e| format!("center: {e}"))?;
    // The requested size in logical points; the centered origin is decided by the window server and
    // is not readable here for the same main-queue reason described in the module header.
    Ok(Rect {
        x: 0,
        y: 0,
        width: DEFAULT_WIDTH as u32,
        height: DEFAULT_HEIGHT as u32,
    })
}

/// Matches the `width`/`height` in tauri.conf.json's main window definition.
const DEFAULT_WIDTH: f64 = 1200.0;
const DEFAULT_HEIGHT: f64 = 800.0;

/// The inner (client) size, in LOGICAL points, to request so the window's OUTER frame lands on
/// `target`.
///
/// `set_size` sets the INNER size, but a target rect describes the screen area the window should
/// occupy — title bar included. Asking for `target.height` directly makes the outer frame that much
/// taller than intended and overflows the bottom of the span.
///
/// The chrome is measured from the window's own outer-vs-inner sizes rather than assumed, since it
/// varies by platform and decoration state. Floors at 1 so a target smaller than its own chrome
/// cannot request a zero-sized window.
fn inner_for_target(target: Rect, chrome_width: f64, chrome_height: f64) -> (f64, f64) {
    (
        (target.width as f64 - chrome_width).max(1.0),
        (target.height as f64 - chrome_height).max(1.0),
    )
}

/// The window's decoration size in LOGICAL points: outer minus inner, both read in the window's own
/// physical space and divided by its scale factor.
fn chrome_size(window: &tauri::WebviewWindow) -> Result<(f64, f64), String> {
    let outer = window.outer_size().map_err(|e| format!("read size: {e}"))?;
    let inner = window
        .inner_size()
        .map_err(|e| format!("read inner size: {e}"))?;
    let scale = window
        .scale_factor()
        .map_err(|e| format!("read scale factor: {e}"))?;
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    Ok((
        outer.width.saturating_sub(inner.width) as f64 / scale,
        outer.height.saturating_sub(inner.height) as f64 / scale,
    ))
}

/// Position BEFORE sizing. A window sized to span three displays while still positioned on one of
/// them can be clamped by the window server to that display's bounds; moving first puts the origin
/// in the target rect so the subsequent resize has room to land.
///
/// Returns the REQUESTED rect. Reading back what the window actually got is not possible here —
/// see the module header: tao queues both setters on the main dispatch queue, and this runs on that
/// thread, so any read-back reports the pre-span geometry.
fn apply(window: &tauri::WebviewWindow, target: Rect) -> Result<Rect, String> {
    window
        .set_position(LogicalPosition::new(target.x as f64, target.y as f64))
        .map_err(|e| format!("set position: {e}"))?;
    let (chrome_width, chrome_height) = chrome_size(window)?;
    let (width, height) = inner_for_target(target, chrome_width, chrome_height);
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| format!("set size: {e}"))?;
    Ok(target)
}

/// One display's identity + geometry, as compared by the watcher: name, origin, and size.
type DisplayFingerprint = (Option<String>, i32, i32, u32, u32);

/// A cheap value that changes whenever the display arrangement does.
fn fingerprint(monitors: &[Monitor]) -> Vec<DisplayFingerprint> {
    monitors
        .iter()
        .map(|m| {
            let area = m.work_area();
            (
                m.name().cloned(),
                area.position.x,
                area.position.y,
                area.size.width,
                area.size.height,
            )
        })
        .collect()
}

/// Watch for display topology changes and emit [`DISPLAYS_CHANGED_EVENT`].
///
/// Tauri exposes no display-connect/disconnect event, so this polls. It exists for safety more than
/// convenience: unplug a monitor while spanned and the window is left at a geometry no remaining
/// display can show, with its title bar potentially off-screen.
///
/// The first tick SEEDS the fingerprint without emitting — otherwise every launch would fire a
/// spurious change and re-span a window the user had deliberately sized.
pub fn start_display_watch(app: AppHandle) {
    std::thread::spawn(move || {
        let mut previous: Option<Vec<DisplayFingerprint>> = None;
        loop {
            std::thread::sleep(WATCH_INTERVAL);
            let Ok(monitors) = app.available_monitors() else {
                continue;
            };
            let current = fingerprint(&monitors);
            match &previous {
                None => previous = Some(current),
                Some(prev) if prev != &current => {
                    let _ = app.emit(DISPLAYS_CHANGED_EVENT, ());
                    previous = Some(current);
                }
                Some(_) => {}
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(x: i32, y: i32, width: u32, height: u32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn no_displays_yields_no_rect() {
        assert_eq!(union_rect(&[]), None);
        assert_eq!(safe_rect(&[]), None);
    }

    /// The three-display setup this module was built for, as WORK AREAS in LOGICAL POINTS — the
    /// units `work_areas()` actually produces. Two 1× 1080p externals flanking a 2× Retina built-in
    /// whose 3024×1964 pixels report as 1512×982 points, less 25 points of menu bar.
    ///
    /// Note which display constrains the span: in points the RETINA panel is the shortest, so it
    /// sets the safe band at 957. Written in pixels the same hardware looks 1964 tall and the
    /// externals appear to constrain it — the inversion that made these fixtures misleading.
    /// `WindowSpanControls.test.tsx` uses the identical numbers.
    fn real_setup() -> Vec<Rect> {
        vec![
            r(0, 0, 1920, 1080),
            r(1920, 25, 1512, 957),
            r(3432, 0, 1920, 1080),
        ]
    }

    /// Every arrangement worth checking, reused by the invariant test below. The synthetic ones
    /// (extremes, degenerate, thin strip) are not meant to model real hardware.
    fn arrangements() -> Vec<Vec<Rect>> {
        vec![
            vec![r(0, 0, 1920, 1080)],
            vec![r(0, 0, 1920, 1080), r(1920, 0, 1920, 1080)],
            real_setup(),
            vec![r(0, 0, 1920, 1080), r(0, 1080, 1920, 1080)],
            vec![r(0, 0, 1920, 1080), r(5000, 0, 2560, 1440)],
            vec![r(-1920, 0, 1920, 1080), r(0, 0, 1920, 1080)],
            vec![r(0, 200, 1920, 1080), r(1920, 25, 1512, 957)],
            vec![r(0, 0, 1512, 982), r(1512, 0, 8000, 10)],
            // Extreme but representable coordinates: the clamping paths must stay total.
            vec![r(i32::MIN, i32::MIN, 4096, 2160), r(0, 0, 1920, 1080)],
            vec![r(i32::MAX - 4096, 0, 4096, 2160)],
        ]
    }

    #[test]
    fn safe_rect_is_present_whenever_union_is() {
        // Callers treat `None` as a hard error ("no displays reported"), so Safe mode returning
        // None where Full mode succeeds would make the default mode fail on an arrangement the
        // other one handles. `is_usable` is what makes this hold: it guarantees every kept rect has
        // two distinct edges per axis AND covers at least one grid cell.
        for rects in arrangements() {
            let union = union_rect(&rects);
            let safe = safe_rect(&rects);
            assert_eq!(
                union.is_some(),
                safe.is_some(),
                "modes disagree on whether a span exists for {rects:?}"
            );
            if let (Some(u), Some(s)) = (union, safe) {
                // The safe rect is contained in the union by construction; a violation would mean
                // the window gets placed somewhere no display reaches.
                assert!(s.left() >= u.left() && s.right() <= u.right(), "{s:?} escapes {u:?}");
                assert!(s.top() >= u.top() && s.bottom() <= u.bottom(), "{s:?} escapes {u:?}");
            }
        }
    }

    #[test]
    fn absurd_dimensions_are_dropped_rather_than_wrapping_negative() {
        // A width past i32::MAX used to become negative through an `as i32` cast, putting `right()`
        // left of `left()` and poisoning every span. Such a rect is not real geometry, so it is
        // dropped — and a sane monitor alongside it still yields a usable span.
        let bogus = Rect { x: 0, y: 0, width: u32::MAX, height: 1080 };
        assert!(!bogus.is_usable());
        assert_eq!(union_rect(&[bogus]), None);
        assert_eq!(safe_rect(&[bogus]), None);

        let mixed = [bogus, r(0, 0, 1920, 1080)];
        assert_eq!(union_rect(&mixed), Some(r(0, 0, 1920, 1080)));
        assert_eq!(safe_rect(&mixed), Some(r(0, 0, 1920, 1080)));
    }

    #[test]
    fn degenerate_rects_are_ignored() {
        // A zero-area monitor must never become the span target — that would resize the window to
        // nothing and leave the user with no way to grab it.
        assert_eq!(union_rect(&[r(0, 0, 0, 1080), r(0, 0, 1920, 0)]), None);
        assert_eq!(safe_rect(&[r(0, 0, 0, 1080), r(0, 0, 1920, 0)]), None);
    }

    #[test]
    fn single_display_spans_to_itself_in_both_modes() {
        let one = [r(0, 0, 1920, 1080)];
        assert_eq!(union_rect(&one), Some(r(0, 0, 1920, 1080)));
        assert_eq!(safe_rect(&one), Some(r(0, 0, 1920, 1080)));
    }

    #[test]
    fn equal_height_row_is_fully_covered_so_safe_equals_full() {
        // Three identical displays side by side DO union into a rectangle, so the two modes agree.
        let row = [
            r(0, 0, 1920, 1080),
            r(1920, 0, 1920, 1080),
            r(3840, 0, 1920, 1080),
        ];
        let expected = Some(r(0, 0, 5760, 1080));
        assert_eq!(union_rect(&row), expected);
        assert_eq!(safe_rect(&row), expected);
    }

    #[test]
    fn ragged_three_display_row_loses_a_band_in_safe_mode() {
        // The real setup (see `real_setup`). In points the built-in's work area is the SHORTEST and
        // sits 25 below the top, so the band every display covers is y 25..982 — full width, 957
        // tall — while the union reaches the externals' full 1080.
        let ragged = real_setup();
        assert_eq!(union_rect(&ragged), Some(r(0, 0, 5352, 1080)));
        assert_eq!(safe_rect(&ragged), Some(r(0, 25, 5352, 957)));
    }

    #[test]
    fn safe_rect_prefers_area_over_width_when_the_band_is_thin() {
        // A very wide but very short strip alongside one tall display: spanning both would give a
        // 10-point-tall window, so the tall display alone wins on area. This is the case that makes
        // "always span everything" wrong. Synthetic — not modelling real hardware.
        let mismatched = [r(0, 0, 1512, 982), r(1512, 0, 8000, 10)];
        let safe = safe_rect(&mismatched).expect("some rect");
        assert_eq!(safe, r(0, 0, 1512, 982));
        // Full mode still reaches across, dead zone and all.
        assert_eq!(union_rect(&mismatched), Some(r(0, 0, 9512, 982)));
    }

    #[test]
    fn vertically_stacked_displays_stay_contiguous_in_safe_mode() {
        // Same width, stacked: the union IS a rectangle, so safe mode may use the whole thing.
        let stack = [r(0, 0, 1920, 1080), r(0, 1080, 1920, 1080)];
        assert_eq!(union_rect(&stack), Some(r(0, 0, 1920, 2160)));
        assert_eq!(safe_rect(&stack), Some(r(0, 0, 1920, 2160)));
    }

    #[test]
    fn disjoint_displays_do_not_span_the_gap() {
        // A display with a gap before the next one: the safe rect must pick ONE side, never bridge
        // the hole, or the window would render into empty space between them.
        let islands = [r(0, 0, 1920, 1080), r(5000, 0, 2560, 1440)];
        assert_eq!(safe_rect(&islands), Some(r(5000, 0, 2560, 1440)));
        assert_eq!(union_rect(&islands), Some(r(0, 0, 7560, 1440)));
    }

    #[test]
    fn negative_origins_are_handled() {
        // macOS puts displays left of the primary at negative x.
        let left_of_primary = [r(-1920, 0, 1920, 1080), r(0, 0, 1920, 1080)];
        assert_eq!(union_rect(&left_of_primary), Some(r(-1920, 0, 3840, 1080)));
        assert_eq!(safe_rect(&left_of_primary), Some(r(-1920, 0, 3840, 1080)));
    }

    #[test]
    fn offset_rows_use_the_overlapping_band_only() {
        // The real setup with the externals dragged 200 points DOWN: the covered band is the
        // intersection of the vertical ranges (y 200..982), so it starts at the lower top edge.
        let offset = [
            r(0, 200, 1920, 1080),
            r(1920, 25, 1512, 957),
            r(3432, 200, 1920, 1080),
        ];
        assert_eq!(safe_rect(&offset), Some(r(0, 200, 5352, 782)));
    }

    #[test]
    fn span_target_routes_to_the_right_rectangle() {
        let ragged = real_setup();
        assert_eq!(span_target(&ragged, SpanMode::Safe), safe_rect(&ragged));
        assert_eq!(span_target(&ragged, SpanMode::Full), union_rect(&ragged));
        assert_ne!(
            span_target(&ragged, SpanMode::Safe),
            span_target(&ragged, SpanMode::Full),
            "the two modes must differ on a ragged arrangement, or the choice is meaningless"
        );
    }

    #[test]
    fn inner_size_request_subtracts_the_window_chrome() {
        // macOS title bar: 28 points of chrome. `set_size` sets the INNER size, so asking for the
        // target height directly makes the OUTER frame 28 points too tall and overflows the span.
        let target = r(0, 25, 5352, 957);
        let (width, height) = inner_for_target(target, 0.0, 28.0);
        assert_eq!(width, 5352.0, "no horizontal chrome to subtract");
        assert_eq!(height, 929.0, "957 target - 28 title bar");
        // The invariant that matters: requested inner + chrome == the target the caller asked for.
        assert_eq!(height + 28.0, target.height as f64);
    }

    #[test]
    fn undecorated_windows_request_the_target_unchanged() {
        let target = r(0, 0, 1920, 1080);
        assert_eq!(inner_for_target(target, 0.0, 0.0), (1920.0, 1080.0));
    }

    #[test]
    fn a_target_smaller_than_its_own_chrome_never_requests_a_zero_sized_window() {
        let (width, height) = inner_for_target(r(0, 0, 10, 10), 20.0, 28.0);
        assert!(width >= 1.0 && height >= 1.0, "got {width}x{height}");
    }

    #[test]
    fn monitor_rects_convert_into_one_shared_logical_point_space() {
        // THE mixed-DPI case, and the reason this module works in points at all. tao reports a
        // monitor's rect as its logical CGDisplayBounds times THAT monitor's scale factor, so a 2x
        // built-in 1512 points wide reports 3024 while a 1x external reports its points unchanged.
        // Unioning those raw numbers compares two different units.
        let retina = to_logical_rect(PhysicalPosition::new(3840, 0), PhysicalSize::new(3024, 1964), 2.0);
        assert_eq!(retina, r(1920, 0, 1512, 982), "2x monitor halves into points");

        let external = to_logical_rect(PhysicalPosition::new(0, 0), PhysicalSize::new(1920, 1080), 1.0);
        assert_eq!(external, r(0, 0, 1920, 1080), "1x monitor is already in points");

        // In point space the two are adjacent (the external's right edge meets the built-in's left),
        // which is what makes a contiguous span possible at all.
        assert_eq!(external.right(), retina.left());
        assert_eq!(union_rect(&[external, retina]), Some(r(0, 0, 3432, 1080)));
    }

    #[test]
    fn a_nonsense_scale_factor_falls_back_to_identity_rather_than_poisoning_coordinates() {
        // tao itself returns 1.0 when it cannot find the screen; a 0.0 or NaN reaching the division
        // would turn every coordinate into infinity or NaN and take the whole span with it.
        let pos = PhysicalPosition::new(100, 200);
        let size = PhysicalSize::new(800, 600);
        assert_eq!(to_logical_rect(pos, size, 0.0), r(100, 200, 800, 600));
        assert_eq!(to_logical_rect(pos, size, f64::NAN), r(100, 200, 800, 600));
        assert_eq!(to_logical_rect(pos, size, -2.0), r(100, 200, 800, 600));
    }

    #[test]
    fn span_mode_deserializes_from_the_frontend_wire_format() {
        assert_eq!(
            serde_json::from_str::<SpanMode>("\"safe\"").unwrap(),
            SpanMode::Safe
        );
        assert_eq!(
            serde_json::from_str::<SpanMode>("\"full\"").unwrap(),
            SpanMode::Full
        );
        assert_eq!(SpanMode::default(), SpanMode::Safe);
    }
}
