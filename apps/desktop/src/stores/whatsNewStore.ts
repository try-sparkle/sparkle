// whatsNewStore — is the in-app "What's New" panel open?
//
// A store rather than component state because the panel has TWO entry points that don't share a
// parent: the StatusStrip's "Changelog" link (via the shared `openChangelog` in appChrome, so every
// existing caller of that helper gets the in-app panel for free) and the launch-time auto-open when
// the app has relaunched onto a new version. Nothing here is persisted — an open panel must never
// be restored as open on the next launch.
import { create } from "zustand";

interface WhatsNewStore {
  open: boolean;
  openWhatsNew: () => void;
  closeWhatsNew: () => void;
}

export const useWhatsNewStore = create<WhatsNewStore>((set) => ({
  open: false,
  openWhatsNew: () => set({ open: true }),
  closeWhatsNew: () => set({ open: false }),
}));
