//! Audio INPUT device enumeration and change notification — the identity layer under `audio.rs`.
//!
//! # Why this module exists (the 2026-07-29 nine-minute dead mic)
//!
//! A user started a screen recorder (Zight) and Sparkle's dictation went silent for nine minutes
//! while the UI showed it happily listening. Capture kept rebuilding, the Deepgram relay kept
//! opening — and not one audio frame arrived.
//!
//! The mechanism is not "the app crashed" and not "the mic was muted". macOS loads every HAL
//! plug-in in `/Library/Audio/Plug-Ins/HAL` **into every process that touches CoreAudio** — so a
//! recorder's driver code runs inside *Sparkle's* address space and registers its own virtual input
//! device in *Sparkle's* device list. This machine has EIGHT such plug-ins installed (Zight, Zoom,
//! MS Teams, two Steam ones, ACE, TVRemoteAudio, Parrot). Any of them can appear, and one of them
//! becoming the default input is enough to redirect capture.
//!
//! The measured signature is the important part, because it is what makes this detectable:
//!
//! ```text
//! MacBook Pro Microphone   callbacks=281 samples=143872 nonzero=143872 peak_rms=0.291  LIVE
//! Microsoft Teams Audio    callbacks=281 samples=143872 nonzero=0      peak_rms=0.000  SILENT
//! ZoomAudioDevice          callbacks=281 samples=287744 nonzero=0      peak_rms=0.000  SILENT
//! Steam Streaming Mic      callbacks=258 samples=264192 nonzero=0      peak_rms=0.000  SILENT
//! ```
//!
//! A virtual device that nobody is feeding delivers callbacks **on schedule, full of exactly
//! `0.0`**. That is why nothing upstream noticed: cpal returned Ok, the stream played, the callback
//! fired at the normal rate, the level meter read 0.0 — indistinguishable from a silent room to
//! every check the app had. It is *not* indistinguishable to arithmetic: a real microphone's noise
//! floor is never exactly zero across thousands of consecutive samples. `audio.rs` counts
//! non-silent frames on that basis.
//!
//! # What this module provides
//!
//! 1. **Stable identity.** `AudioDeviceID` is a runtime handle that CoreAudio reassigns as plug-ins
//!    load and unload; `kAudioDevicePropertyDeviceUID` is a stable string that survives both. All
//!    persistence and all device selection goes through the UID — never the numeric id, and never
//!    "whatever is default right now".
//! 2. **Change notification.** A property listener on the system object fires when the device list
//!    or the default input changes, so capture can rebind instead of holding a stream that no
//!    longer carries audio.
//!
//! Non-macOS builds get a stub: cpal's default-device path is all the Windows port has, and it has
//! no HAL-plug-in equivalent to defend against.

/// One selectable audio input device.
///
/// `uid` is the persistence key (see the module docs on why the numeric id is not). `is_virtual`
/// is advisory — it marks a software/plug-in device (CoreAudio transport type `virt`) so the UI can
/// tell "MacBook Pro Microphone" apart from the eight loopback drivers that look identical in a
/// bare name list. We deliberately do NOT refuse to bind a virtual device: some are legitimate
/// (an audio interface's aggregate, a virtual device the user genuinely records through), and
/// hard-coding a vendor blocklist is exactly the special-casing this fix is meant to avoid.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputDevice {
    pub uid: String,
    pub name: String,
    /// True for the device CoreAudio currently reports as `kAudioHardwarePropertyDefaultInputDevice`.
    pub is_default: bool,
    /// True when the CoreAudio transport type is `virt` — a software device from a HAL plug-in.
    /// These are the ones that can carry system OUTPUT rather than a microphone.
    pub is_virtual: bool,
    /// True for the machine's built-in microphone (transport type `bltn`) — the safest automatic
    /// choice, and the tie-break when we have to pick a physical input ourselves.
    pub is_builtin: bool,
}

/// Which device a capture should open.
///
/// `Uid` pins capture to one specific microphone so a virtual device appearing mid-session cannot
/// displace it. `Auto` is what users who have never opened the picker get — and it is deliberately
/// NOT "whatever CoreAudio calls the default", for a privacy reason spelled out on
/// [`select_device`]: several of the HAL plug-ins on a typical machine exist precisely to expose
/// system OUTPUT as an input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceChoice {
    /// No explicit pick — choose automatically, preferring a real hardware microphone.
    /// `allow_virtual` is the advanced, off-by-default opt-in described on [`select_device`].
    Auto { allow_virtual: bool },
    /// Bind to this specific `kAudioDevicePropertyDeviceUID`.
    ///
    /// Carries `allow_virtual` even though an explicit pick is honoured regardless of what the
    /// device IS: the flag is for the DEGRADED paths. When the pinned device is missing or its name
    /// is ambiguous we fall back to the automatic rules, and those rules need the user's opt-in.
    /// Dropping it here (as an earlier version did) silently revoked a setting the user had turned
    /// on the moment their pinned device was unplugged — and then told them, in the refusal copy,
    /// to go and enable the very option they had already enabled (roborev 55275).
    Uid { uid: String, allow_virtual: bool },
}

impl DeviceChoice {
    /// Build from persisted config. An empty/absent UID means "no choice made" → `Auto`.
    pub fn from_config(uid: Option<&str>, allow_virtual: bool) -> DeviceChoice {
        match uid.map(str::trim) {
            Some(u) if !u.is_empty() => DeviceChoice::Uid { uid: u.to_string(), allow_virtual },
            _ => DeviceChoice::Auto { allow_virtual },
        }
    }
}

/// Why [`select_device`] landed on the device it did. Every variant is logged by the caller, and
/// several are user-visible — an automatic substitution that nobody can see is how a microphone
/// quietly becomes a system-audio tap for a whole day without anyone noticing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectionReason {
    /// The user's chosen device, found and bound.
    ChosenUid,
    /// The chosen device is gone (unplugged, or its driver unloaded) — fell back.
    ChosenUidMissing,
    /// Two devices share a name, so a UID cannot be resolved to exactly one cpal device.
    AmbiguousNames,
    /// Automatic, and the system default is a real hardware input — used it.
    AutoDefaultIsPhysical,
    /// Automatic, and the system default was VIRTUAL — deliberately picked a physical input instead.
    AutoAvoidedVirtualDefault,
    /// Automatic, advanced opt-in is ON, so a virtual default was accepted.
    AutoVirtualAllowed,
    /// Automatic, but no physical input exists at all — nothing better than the default.
    AutoNoPhysicalInput,
}

/// The outcome of device selection.
///
/// Deliberately NOT `Option<String>`. An earlier version returned `None` for "couldn't pick one"
/// and the caller answered that by opening `host.default_input_device()` unconditionally — which
/// re-entered the very privacy failure this module exists to prevent (roborev 55275). Unplug a
/// UID-pinned headset while a HAL plug-in holds the default and capture would silently bind a
/// loopback. The three outcomes are now distinct so no caller can collapse them again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    /// Open the device with this name.
    Open { name: String, reason: SelectionReason },
    /// There is no SAFE device to open. The caller must fail rather than fall back — falling back
    /// is what put system audio in the transcript.
    Refuse { reason: SelectionReason },
    /// We know nothing about the devices (enumeration returned nothing, or this is not macOS), so
    /// there is no policy to apply and cpal's own default is the only option.
    SystemDefault,
}

/// Whether exactly one device carries this name.
///
/// The guard on the UID→name→cpal translation, and it must apply to EVERY path that resolves a
/// name, not just the explicit-UID one (roborev 55275). If a virtual device shares a name with the
/// physical device we chose, `host.input_devices().find(name)` returns whichever enumerates first
/// and the `BoundDevice` we build then carries the OTHER device's uid/is_virtual — so the log and
/// the `dictation://device` event would confidently assert the wrong device, exactly when it
/// matters most. Duplicate names are trivially producible by renaming in Audio MIDI Setup.
///
/// Per-name rather than global: two unrelated devices sharing a name does not make OUR pick
/// ambiguous, and refusing on that would be needlessly brittle.
pub fn name_is_unambiguous(devices: &[InputDevice], name: &str) -> bool {
    devices.iter().filter(|d| d.name == name).count() == 1
}

/// Whether every device name is distinct. Retained for diagnostics; selection uses the per-name
/// [`name_is_unambiguous`] check instead.
pub fn unique_names(devices: &[InputDevice]) -> bool {
    let mut names: Vec<&str> = devices.iter().map(|d| d.name.as_str()).collect();
    names.sort_unstable();
    let before = names.len();
    names.dedup();
    names.len() == before
}

/// Rank a physical candidate — lower is better. The built-in microphone wins, then any other real
/// hardware input. Used only to break ties when we must pick a physical device ourselves, and it
/// must be deterministic rather than dependent on CoreAudio's enumeration order.
fn physical_rank(d: &InputDevice) -> u8 {
    if d.is_builtin {
        0
    } else {
        1
    }
}

/// Build an `Open` for `d`, or fall through to `Refuse`/auto when its name is ambiguous.
fn open_unambiguous(
    devices: &[InputDevice],
    d: &InputDevice,
    reason: SelectionReason,
) -> Option<Resolution> {
    name_is_unambiguous(devices, &d.name)
        .then(|| Resolution::Open { name: d.name.clone(), reason })
}

/// Choose the input device to open.
///
/// # Why "the system default" is not an acceptable answer
///
/// Two separate incidents on 2026-07-29, one mechanism. A machine can carry many CoreAudio HAL
/// plug-ins (eight on the affected one: Zight, Zoom, MS Teams, two Steam, ACE, TVRemoteAudio,
/// Parrot), and several exist *specifically* to publish an input device that carries system OUTPUT
/// — that is what screen recorders and streaming tools install them for. Following
/// `kAudioHardwarePropertyDefaultInputDevice` therefore means capture can land on:
///
/// * a virtual device nobody is feeding → the nine-minute dead mic (frames arrive, all exactly
///   zero — see `audio::CaptureHealth`), or
/// * a loopback that mixes speaker output in → Sparkle transcribing a Twitch stream, a call, or a
///   third party's voice into the composer.
///
/// The second is a PRIVACY posture, not a glitch: "Sparkle listens to your microphone" and
/// "Sparkle can transcribe anything playing on this machine" are materially different promises,
/// and users assume the first. So the automatic path prefers a real hardware input and REFUSES to
/// silently accept a virtual one; `allow_virtual` exists for the deliberate meeting-transcription
/// case and is off by default.
///
/// Every fallback re-enters this policy rather than escaping it: a missing UID or an ambiguous
/// name degrades to the automatic rules, never to the raw system default.
///
/// Pure, so every branch above is unit-tested without an audio device.
pub fn select_device(choice: &DeviceChoice, devices: &[InputDevice]) -> Resolution {
    // Nothing enumerated: non-macOS, or CoreAudio told us nothing. No policy is applicable, and
    // refusing here would break the Windows port, which has no HAL-plug-in hazard to defend.
    if devices.is_empty() {
        return Resolution::SystemDefault;
    }

    let allow_virtual = match choice {
        DeviceChoice::Uid { uid, allow_virtual } => {
            match devices.iter().find(|d| &d.uid == uid) {
                // An explicit pick is honoured even if virtual: the user chose it by name, so
                // nothing is hidden. Ambiguity is still fatal to the translation, so that falls
                // through to the automatic rules below rather than gambling.
                Some(d) => {
                    if let Some(open) = open_unambiguous(devices, d, SelectionReason::ChosenUid) {
                        return open;
                    }
                    return auto_select(devices, *allow_virtual, SelectionReason::AmbiguousNames);
                }
                // Unplugged headset / unloaded driver. Degrade to the AUTOMATIC rules — which
                // still refuse a virtual device unless the user opted in — instead of the raw
                // default. The opt-in is CARRIED here rather than hardcoded false: see the note on
                // `DeviceChoice::Uid`. Hardcoding it revoked the setting exactly when the fallback
                // needed it, then told the user to enable what they had already enabled.
                None => {
                    return auto_select(devices, *allow_virtual, SelectionReason::ChosenUidMissing)
                }
            }
        }
        DeviceChoice::Auto { allow_virtual } => *allow_virtual,
    };
    auto_select(devices, allow_virtual, SelectionReason::AutoDefaultIsPhysical)
}

/// The automatic rules, shared by the `Auto` choice and by every fallback so they cannot diverge.
///
/// `fallback_reason` is reported instead of the ordinary one when we arrived here by degrading
/// from an explicit pick, so the caller can tell the user what it substituted and why.
fn auto_select(
    devices: &[InputDevice],
    allow_virtual: bool,
    fallback_reason: SelectionReason,
) -> Resolution {
    let degraded = !matches!(fallback_reason, SelectionReason::AutoDefaultIsPhysical);
    let reason_for = |ordinary: SelectionReason| {
        if degraded {
            fallback_reason.clone()
        } else {
            ordinary
        }
    };

    let default = devices.iter().find(|d| d.is_default);
    // The ordinary, healthy case: the default is a real microphone.
    if let Some(d) = default.filter(|d| !d.is_virtual) {
        if let Some(open) = open_unambiguous(devices, d, reason_for(SelectionReason::AutoDefaultIsPhysical)) {
            return open;
        }
    }
    // The default is virtual and the user has explicitly opted in.
    if allow_virtual {
        if let Some(d) = default {
            if let Some(open) = open_unambiguous(devices, d, reason_for(SelectionReason::AutoVirtualAllowed)) {
                return open;
            }
        }
    }
    // Prefer a real hardware input — the branch that keeps system audio out of the composer.
    let physical = devices
        .iter()
        .filter(|d| !d.is_virtual && name_is_unambiguous(devices, &d.name))
        .min_by_key(|d| (physical_rank(d), d.name.clone()));
    if let Some(d) = physical {
        return Resolution::Open {
            name: d.name.clone(),
            reason: reason_for(SelectionReason::AutoAvoidedVirtualDefault),
        };
    }
    // No usable physical input exists. With the opt-in on, take any unambiguous device; without
    // it, REFUSE — opening a virtual device here is precisely the silent fallback that put a
    // Twitch stream in the transcript.
    if allow_virtual {
        if let Some(d) = devices.iter().find(|d| name_is_unambiguous(devices, &d.name)) {
            return Resolution::Open {
                name: d.name.clone(),
                reason: reason_for(SelectionReason::AutoVirtualAllowed),
            };
        }
    }
    Resolution::Refuse { reason: SelectionReason::AutoNoPhysicalInput }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::InputDevice;
    use core_foundation_sys::base::CFRelease;
    use core_foundation_sys::string::{
        kCFStringEncodingUTF8, CFStringGetCString, CFStringGetLength, CFStringRef,
    };
    use coreaudio_sys::{
        kAudioDevicePropertyDeviceUID, kAudioDevicePropertyMute,
        kAudioDevicePropertyStreamConfiguration,
        kAudioDevicePropertyTransportType, kAudioHardwarePropertyDefaultInputDevice,
        kAudioHardwarePropertyDevices, kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyScopeInput, kAudioObjectSystemObject, AudioBufferList, AudioDeviceID,
        AudioObjectAddPropertyListener, AudioObjectGetPropertyData, AudioObjectHasProperty,
        AudioObjectGetPropertyDataSize, AudioObjectID, AudioObjectPropertyAddress,
        AudioObjectRemovePropertyListener, OSStatus,
    };
    use std::ffi::c_void;

    /// The "main"/"master" element, 0 in every SDK. Spelled out rather than imported because the
    /// constant was renamed (`…ElementMaster` → `…ElementMain`) across SDK versions, and a build
    /// that breaks on a bindgen refresh is a worse outcome than a named zero.
    const ELEM_MAIN: u32 = 0;

    /// CoreAudio transport type for a software/plug-in device: the FourCC `'virt'`.
    const TRANSPORT_VIRTUAL: u32 = u32::from_be_bytes(*b"virt");
    /// CoreAudio transport type for the machine's own built-in audio hardware: the FourCC `'bltn'`.
    const TRANSPORT_BUILTIN: u32 = u32::from_be_bytes(*b"bltn");

    fn addr(selector: u32, scope: u32) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress { mSelector: selector, mScope: scope, mElement: ELEM_MAIN }
    }

    /// Copy a CoreAudio-owned `CFStringRef` into an owned Rust `String` and release it.
    ///
    /// SAFETY: `s` must be a +1 (caller-owned) CFStringRef as returned by
    /// `AudioObjectGetPropertyData` for a CFString-typed property — those follow the Copy rule, so
    /// we own the reference and must release it exactly once, which we do here on every path.
    unsafe fn take_cfstring(s: CFStringRef) -> Option<String> {
        if s.is_null() {
            return None;
        }
        // Worst case 4 UTF-8 bytes per UTF-16 unit, plus the NUL terminator.
        let cap = (CFStringGetLength(s) as usize) * 4 + 1;
        let mut buf = vec![0i8; cap];
        let ok = CFStringGetCString(s, buf.as_mut_ptr(), cap as isize, kCFStringEncodingUTF8);
        CFRelease(s as *const c_void);
        if ok == 0 {
            return None;
        }
        let bytes: Vec<u8> = buf.iter().take_while(|&&c| c != 0).map(|&c| c as u8).collect();
        String::from_utf8(bytes).ok()
    }

    fn cfstring_prop(id: AudioDeviceID, selector: u32) -> Option<String> {
        let a = addr(selector, kAudioObjectPropertyScopeGlobal);
        let mut out: CFStringRef = std::ptr::null();
        let mut size = std::mem::size_of::<CFStringRef>() as u32;
        let st = unsafe {
            AudioObjectGetPropertyData(
                id,
                &a,
                0,
                std::ptr::null(),
                &mut size,
                &mut out as *mut _ as *mut c_void,
            )
        };
        if st != 0 {
            return None;
        }
        unsafe { take_cfstring(out) }
    }

    pub fn default_input_id() -> Option<AudioDeviceID> {
        let a = addr(kAudioHardwarePropertyDefaultInputDevice, kAudioObjectPropertyScopeGlobal);
        let mut id: AudioDeviceID = 0;
        let mut size = std::mem::size_of::<AudioDeviceID>() as u32;
        let st = unsafe {
            AudioObjectGetPropertyData(
                kAudioObjectSystemObject,
                &a,
                0,
                std::ptr::null(),
                &mut size,
                &mut id as *mut _ as *mut c_void,
            )
        };
        (st == 0 && id != 0).then_some(id)
    }

    fn all_device_ids() -> Vec<AudioDeviceID> {
        let a = addr(kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal);
        let mut size: u32 = 0;
        let st = unsafe {
            AudioObjectGetPropertyDataSize(
                kAudioObjectSystemObject,
                &a,
                0,
                std::ptr::null(),
                &mut size,
            )
        };
        if st != 0 || size == 0 {
            return Vec::new();
        }
        let mut ids = vec![0 as AudioDeviceID; size as usize / std::mem::size_of::<AudioDeviceID>()];
        let st = unsafe {
            AudioObjectGetPropertyData(
                kAudioObjectSystemObject,
                &a,
                0,
                std::ptr::null(),
                &mut size,
                ids.as_mut_ptr() as *mut c_void,
            )
        };
        if st != 0 {
            return Vec::new();
        }
        ids
    }

    /// Total INPUT channels. Zero means the device cannot record — an output-only device, which
    /// CoreAudio lists alongside microphones and which must not appear in a microphone picker.
    fn input_channels(id: AudioDeviceID) -> u32 {
        let a = addr(kAudioDevicePropertyStreamConfiguration, kAudioObjectPropertyScopeInput);
        let mut size: u32 = 0;
        if unsafe { AudioObjectGetPropertyDataSize(id, &a, 0, std::ptr::null(), &mut size) } != 0 {
            return 0;
        }
        if (size as usize) < std::mem::size_of::<AudioBufferList>() {
            return 0;
        }
        let mut buf = vec![0u8; size as usize];
        if unsafe {
            AudioObjectGetPropertyData(
                id,
                &a,
                0,
                std::ptr::null(),
                &mut size,
                buf.as_mut_ptr() as *mut c_void,
            )
        } != 0
        {
            return 0;
        }
        // SAFETY: CoreAudio filled `buf` with an AudioBufferList whose trailing mBuffers array has
        // mNumberBuffers entries; we sized the allocation from its own GetPropertyDataSize and
        // bailed above if it is smaller than the header, so the reads below stay in bounds.
        unsafe {
            let list = buf.as_ptr() as *const AudioBufferList;
            let n = (*list).mNumberBuffers as usize;
            let first = (*list).mBuffers.as_ptr();
            (0..n).map(|i| (*first.add(i)).mNumberChannels).sum()
        }
    }

    /// The device's CoreAudio transport type FourCC, or `None` if it won't say.
    fn transport_type(id: AudioDeviceID) -> Option<u32> {
        let a = addr(kAudioDevicePropertyTransportType, kAudioObjectPropertyScopeGlobal);
        let mut v: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        let st = unsafe {
            AudioObjectGetPropertyData(
                id,
                &a,
                0,
                std::ptr::null(),
                &mut size,
                &mut v as *mut _ as *mut c_void,
            )
        };
        (st == 0).then_some(v)
    }

    /// Whether the device with this UID reports itself MUTED on its input scope.
    ///
    /// `None` = the device does not implement `kAudioDevicePropertyMute`, which is common — plenty
    /// of hardware mute switches simply stop sending audio without telling the host anything. So a
    /// `None` here means "don't know", NOT "not muted", and the caller must not treat the two the
    /// same: accusing a device of being broken when the user muted it themselves is the false
    /// positive this exists to avoid (roborev 55275).
    pub fn is_muted(uid: &str) -> Option<bool> {
        let id = all_device_ids()
            .into_iter()
            .find(|&id| cfstring_prop(id, kAudioDevicePropertyDeviceUID).as_deref() == Some(uid))?;
        let a = addr(kAudioDevicePropertyMute, kAudioObjectPropertyScopeInput);
        // Ask first: reading an unsupported property yields a garbage 0 that reads as "not muted".
        if unsafe { AudioObjectHasProperty(id, &a) } == 0 {
            return None;
        }
        let mut v: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        let st = unsafe {
            AudioObjectGetPropertyData(
                id,
                &a,
                0,
                std::ptr::null(),
                &mut size,
                &mut v as *mut _ as *mut c_void,
            )
        };
        (st == 0).then_some(v != 0)
    }

    pub fn list_input_devices() -> Vec<InputDevice> {
        let default = default_input_id();
        all_device_ids()
            .into_iter()
            .filter(|&id| input_channels(id) > 0)
            .filter_map(|id| {
                let transport = transport_type(id);
                Some(InputDevice {
                    // No UID means nothing stable to persist, so the device is unusable as a
                    // *choice* — skip it rather than offer a selection that won't survive a replug.
                    uid: cfstring_prop(id, kAudioDevicePropertyDeviceUID)?,
                    name: cfstring_prop(id, kAudioObjectPropertyName)?,
                    is_default: Some(id) == default,
                    is_virtual: transport == Some(TRANSPORT_VIRTUAL),
                    is_builtin: transport == Some(TRANSPORT_BUILTIN),
                })
            })
            .collect()
    }

    /// Boxed callback kept alive for as long as the listener is registered.
    type Callback = Box<dyn Fn() + Send + Sync + 'static>;

    /// The two system properties worth watching. The device LIST changing is the one that fires
    /// when a HAL plug-in's device appears or disappears (a recorder starting); the DEFAULT INPUT
    /// changing is the classic headset-plugged-in case.
    const WATCHED: [u32; 2] =
        [kAudioHardwarePropertyDevices, kAudioHardwarePropertyDefaultInputDevice];

    /// Unregisters the property listeners and frees the callback when dropped.
    pub struct DeviceChangeWatcher {
        callback: *mut Callback,
    }

    // SAFETY: the only field is a heap pointer to a `Send + Sync` callback that this type owns
    // exclusively; nothing reads or writes it except registration (in `start`) and deregistration
    // (in `Drop`), both of which happen on whichever single thread owns the watcher.
    unsafe impl Send for DeviceChangeWatcher {}
    unsafe impl Sync for DeviceChangeWatcher {}

    /// CoreAudio invokes this from its own dispatch queue, across an `extern "C"` boundary.
    ///
    /// A Rust panic cannot unwind across that boundary — it hits `panic_cannot_unwind` and
    /// `abort()`s the process — so the whole body is wrapped in `catch_unwind`, exactly as the
    /// capture frame handler in `audio.rs` is and for exactly the same reason.
    unsafe extern "C" fn on_property_changed(
        _obj: AudioObjectID,
        _n: u32,
        _addrs: *const AudioObjectPropertyAddress,
        client_data: *mut c_void,
    ) -> OSStatus {
        let _ = std::panic::catch_unwind(|| {
            if client_data.is_null() {
                return;
            }
            // SAFETY: `client_data` is the pointer we passed to AudioObjectAddPropertyListener, and
            // Drop removes the listener BEFORE freeing it — so it is live for every invocation.
            let cb = &*(client_data as *const Callback);
            cb();
        });
        0
    }

    impl DeviceChangeWatcher {
        /// Register for device-list and default-input changes. `on_change` runs on a CoreAudio
        /// thread, so it must be cheap and non-blocking — signal, don't work.
        pub fn start(on_change: impl Fn() + Send + Sync + 'static) -> DeviceChangeWatcher {
            let callback: *mut Callback = Box::into_raw(Box::new(Box::new(on_change)));
            for selector in WATCHED {
                let a = addr(selector, kAudioObjectPropertyScopeGlobal);
                let st = unsafe {
                    AudioObjectAddPropertyListener(
                        kAudioObjectSystemObject,
                        &a,
                        Some(on_property_changed),
                        callback as *mut c_void,
                    )
                };
                if st != 0 {
                    tracing::warn!(
                        target: "dictation",
                        selector, status = st,
                        "could not register a CoreAudio device-change listener; \
                         a mid-session device change will be caught by the frame watchdog instead"
                    );
                }
            }
            DeviceChangeWatcher { callback }
        }
    }

    impl Drop for DeviceChangeWatcher {
        fn drop(&mut self) {
            // Order is load-bearing: remove BOTH listeners first, so CoreAudio can no longer be
            // dispatching `on_property_changed` against the callback, and only then free it.
            // Reversing this would let an in-flight notification read freed memory.
            for selector in WATCHED {
                let a = addr(selector, kAudioObjectPropertyScopeGlobal);
                unsafe {
                    AudioObjectRemovePropertyListener(
                        kAudioObjectSystemObject,
                        &a,
                        Some(on_property_changed),
                        self.callback as *mut c_void,
                    );
                }
            }
            // SAFETY: reconstitutes the Box created in `start`; no listener can reach it now.
            unsafe { drop(Box::from_raw(self.callback)) };
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::InputDevice;

    /// Non-macOS has no HAL-plug-in hazard and no CoreAudio UID namespace. Report nothing, so the
    /// picker shows "System default" only and capture keeps cpal's default-device behaviour.
    pub fn list_input_devices() -> Vec<InputDevice> {
        Vec::new()
    }

    /// No CoreAudio mute property off macOS — always "don't know".
    pub fn is_muted(_uid: &str) -> Option<bool> {
        None
    }

    pub struct DeviceChangeWatcher;

    impl DeviceChangeWatcher {
        pub fn start(_on_change: impl Fn() + Send + Sync + 'static) -> DeviceChangeWatcher {
            DeviceChangeWatcher
        }
    }
}

pub use imp::{is_muted, list_input_devices, DeviceChangeWatcher};

#[cfg(test)]
mod tests {
    use super::*;

    /// A real hardware microphone (not built-in — e.g. a USB mic).
    fn physical(uid: &str, name: &str, is_default: bool) -> InputDevice {
        InputDevice {
            uid: uid.into(),
            name: name.into(),
            is_default,
            is_virtual: false,
            is_builtin: false,
        }
    }

    /// The machine's built-in microphone.
    fn builtin(is_default: bool) -> InputDevice {
        InputDevice {
            uid: "BuiltInMicrophoneDevice".into(),
            name: "MacBook Pro Microphone".into(),
            is_default,
            is_virtual: false,
            is_builtin: true,
        }
    }

    /// A HAL plug-in's virtual device — the kind that can carry system OUTPUT.
    fn virtual_dev(uid: &str, name: &str, is_default: bool) -> InputDevice {
        InputDevice {
            uid: uid.into(),
            name: name.into(),
            is_default,
            is_virtual: true,
            is_builtin: false,
        }
    }

    const AUTO: DeviceChoice = DeviceChoice::Auto { allow_virtual: false };

    /// A pinned device with the advanced virtual-input opt-in OFF — what almost every user has.
    fn pinned(uid: &str) -> DeviceChoice {
        DeviceChoice::Uid { uid: uid.into(), allow_virtual: false }
    }

    #[test]
    fn from_config_treats_absent_and_blank_as_automatic() {
        assert_eq!(DeviceChoice::from_config(None, false), AUTO);
        assert_eq!(DeviceChoice::from_config(Some(""), false), AUTO);
        assert_eq!(DeviceChoice::from_config(Some("   "), false), AUTO);
        assert_eq!(
            DeviceChoice::from_config(Some("BuiltInMicrophoneDevice"), false),
            pinned("BuiltInMicrophoneDevice")
        );
        assert_eq!(
            DeviceChoice::from_config(None, true),
            DeviceChoice::Auto { allow_virtual: true }
        );
        // The opt-in must SURVIVE a pin. It is not redundant with the pick: it is what the degraded
        // paths (missing / ambiguous) fall back on, so discarding it here revokes the setting the
        // moment the pinned device is unplugged.
        assert_eq!(
            DeviceChoice::from_config(Some("BlackHole_UID"), true),
            DeviceChoice::Uid { uid: "BlackHole_UID".into(), allow_virtual: true }
        );
    }

    #[test]
    fn a_chosen_uid_binds_to_that_device_even_when_another_is_default() {
        // THE regression this module exists for. On 2026-07-29 a screen recorder's HAL plug-in
        // loaded into Sparkle's process and capture stopped receiving audio while the UI showed it
        // listening. Binding must follow the user's UID, NOT `is_default`.
        let devices = vec![
            builtin(false),
            virtual_dev("com.linebreak.CloudAppMacOSX.ASP", "Zight Virtual Audio", true),
        ];
        assert_eq!(
            select_device(&pinned("BuiltInMicrophoneDevice"), &devices),
            Resolution::Open {
                name: "MacBook Pro Microphone".into(),
                reason: SelectionReason::ChosenUid
            }
        );
    }

    #[test]
    fn automatic_refuses_a_virtual_default_and_picks_the_real_microphone() {
        // The PRIVACY case, and the one that cost the user a day: several HAL plug-ins publish
        // system OUTPUT as an input device, so following the default let Sparkle transcribe a
        // Twitch stream — and other people's conversations — into the composer.
        let devices = vec![
            virtual_dev("zoom.us.zoomaudiodevice.001", "ZoomAudioDevice", true),
            builtin(false),
        ];
        assert_eq!(
            select_device(&AUTO, &devices),
            Resolution::Open {
                name: "MacBook Pro Microphone".into(),
                reason: SelectionReason::AutoAvoidedVirtualDefault
            },
            "automatic selection must not accept a virtual device that can carry system audio"
        );
    }

    #[test]
    fn automatic_keeps_a_physical_default_untouched() {
        // We must not "fix" a default that was never broken — a user with a USB mic set as default
        // keeps it rather than being yanked onto the built-in.
        let devices = vec![builtin(false), physical("USB_Mic_UID", "Yeti Nano", true)];
        assert_eq!(
            select_device(&AUTO, &devices),
            Resolution::Open {
                name: "Yeti Nano".into(),
                reason: SelectionReason::AutoDefaultIsPhysical
            }
        );
    }

    #[test]
    fn the_advanced_opt_in_allows_a_virtual_default() {
        // Same device list as the refusal test — the ONLY difference is the opt-in, which is what
        // proves the flag is doing the work rather than something about the devices.
        let devices = vec![
            virtual_dev("zoom.us.zoomaudiodevice.001", "ZoomAudioDevice", true),
            builtin(false),
        ];
        assert_eq!(
            select_device(&DeviceChoice::Auto { allow_virtual: true }, &devices),
            Resolution::Open {
                name: "ZoomAudioDevice".into(),
                reason: SelectionReason::AutoVirtualAllowed
            }
        );
    }

    #[test]
    fn automatic_prefers_the_builtin_when_it_must_choose_a_physical_input() {
        // Deterministic tie-break among real hardware, rather than CoreAudio's enumeration order.
        let devices = vec![
            virtual_dev("ace", "ACE Virtual Input", true),
            physical("USB_Mic_UID", "Some USB Interface", false),
            builtin(false),
        ];
        assert!(matches!(
            select_device(&AUTO, &devices),
            Resolution::Open { ref name, .. } if name == "MacBook Pro Microphone"
        ));
    }

    #[test]
    fn with_only_virtual_inputs_selection_refuses_rather_than_opening_one() {
        // roborev 55275 (High). The old shape returned "no opinion" here and the CALLER answered
        // that by opening host.default_input_device() unconditionally — reinstating the exact
        // privacy failure. There must be no outcome that a caller can read as "just take the
        // default": with no real microphone and no opt-in, this REFUSES.
        let devices = vec![virtual_dev("a", "Steam Streaming Microphone", true)];
        assert_eq!(
            select_device(&AUTO, &devices),
            Resolution::Refuse { reason: SelectionReason::AutoNoPhysicalInput }
        );
        // …and the opt-in is what unlocks it, nothing else.
        assert!(matches!(
            select_device(&DeviceChoice::Auto { allow_virtual: true }, &devices),
            Resolution::Open { .. }
        ));
    }

    #[test]
    fn an_unplugged_chosen_device_degrades_to_a_real_mic_not_to_the_virtual_default() {
        // roborev 55275 (High), the concrete trigger: a USB headset pinned by UID is unplugged
        // mid-session while a HAL plug-in holds the default input. The fallback must re-enter the
        // physical-preferring policy — landing on the built-in mic — rather than binding the
        // loopback and quietly transcribing system audio.
        let devices = vec![
            virtual_dev("zoom.us.zoomaudiodevice.001", "ZoomAudioDevice", true),
            builtin(false),
        ];
        assert_eq!(
            select_device(&pinned("UnpluggedHeadset_UID"), &devices),
            Resolution::Open {
                name: "MacBook Pro Microphone".into(),
                reason: SelectionReason::ChosenUidMissing
            },
            "a missing chosen device must fall back to a REAL mic, never to a virtual default"
        );
    }

    #[test]
    fn a_pinned_device_going_missing_does_not_revoke_the_virtual_opt_in() {
        // The user who deliberately turned ON allow_virtual (meeting transcription) AND pinned a
        // device. When the pin goes missing, the degraded path used to hardcode allow_virtual=false:
        // with only virtual inputs left it Refused, killing capture outright — and the refusal copy
        // told them to allow non-microphone input, which they had already done. The setting must
        // survive the substitution.
        let devices = vec![virtual_dev("BlackHole2ch_UID", "BlackHole 2ch", true)];
        let opted_in =
            DeviceChoice::Uid { uid: "UnpluggedHeadset_UID".into(), allow_virtual: true };
        assert_eq!(
            select_device(&opted_in, &devices),
            Resolution::Open {
                name: "BlackHole 2ch".into(),
                reason: SelectionReason::ChosenUidMissing
            },
            "an opted-in user must keep their opt-in when the pinned device disappears"
        );
        // And the default stays safe for everyone who did NOT opt in: same devices, no opt-in →
        // Refuse rather than silently binding a system-audio tap.
        assert_eq!(
            select_device(&pinned("UnpluggedHeadset_UID"), &devices),
            Resolution::Refuse { reason: SelectionReason::AutoNoPhysicalInput },
            "without the opt-in, a virtual-only fallback must still refuse"
        );
    }

    #[test]
    fn an_ambiguous_name_is_never_opened_on_the_automatic_path_either() {
        // roborev 55275 (Medium). The UID->name->cpal translation is only sound while the chosen
        // NAME is unique, and that applies to automatic selection too — cpal's find() would return
        // whichever device enumerates first, and the BoundDevice we then build would carry the
        // OTHER device's uid/is_virtual, so the log and the dictation://device event would
        // confidently name the wrong device. Here the physical default shares a name with a
        // virtual device, so it must be skipped in favour of the unambiguous built-in.
        let devices = vec![
            physical("real_uid", "USB Audio Device", true),
            virtual_dev("fake_uid", "USB Audio Device", false),
            builtin(false),
        ];
        assert_eq!(
            select_device(&AUTO, &devices),
            Resolution::Open {
                name: "MacBook Pro Microphone".into(),
                reason: SelectionReason::AutoAvoidedVirtualDefault
            },
            "an ambiguous name must never be opened, even when it is the physical default"
        );
    }

    #[test]
    fn an_ambiguous_chosen_uid_degrades_to_the_automatic_rules() {
        let devices = vec![
            physical("a", "USB Audio Device", true),
            virtual_dev("b", "USB Audio Device", false),
            builtin(false),
        ];
        assert_eq!(
            select_device(&pinned("a"), &devices),
            Resolution::Open {
                name: "MacBook Pro Microphone".into(),
                reason: SelectionReason::AmbiguousNames
            }
        );
        assert!(!unique_names(&devices));
        assert!(name_is_unambiguous(&devices, "MacBook Pro Microphone"));
        assert!(!name_is_unambiguous(&devices, "USB Audio Device"));
    }

    #[test]
    fn an_empty_device_list_defers_to_cpal_rather_than_refusing() {
        // Non-macOS, or CoreAudio told us nothing. There is no policy to apply and no HAL-plug-in
        // hazard to defend against, so refusing here would break the Windows port outright.
        assert_eq!(select_device(&AUTO, &[]), Resolution::SystemDefault);
        assert_eq!(select_device(&pinned("x"), &[]), Resolution::SystemDefault);
    }
}
