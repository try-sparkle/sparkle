// cableStore — the ONE holder of the cockpit's connection state.
//
// Deliberately thin: every rule lives in `engine/cable.ts` as a pure function, and this store only
// applies them. That split is the point. MAPPING.md's instruction is that `data-wired` is the whole
// connection feature and must not become scattered component state; a store whose actions are
// one-line applications of a tested reducer is the shape that keeps that true — there is nowhere
// else for a rule to accumulate.
//
// In-memory, not persisted. A patched cable is a statement about the agent you are talking to right
// now; restoring it across a relaunch would re-wire the concierge to a row the user has not looked
// at, before they have said anything.
import { create } from "zustand";
import {
  CABLE_REST,
  patchCable,
  setOverlay,
  unbindCable,
  type CableState,
  type OverlaySurface,
  type PairSide,
} from "../engine/cable";

interface CableStore extends CableState {
  /** Patch the cable into a side's build agent. Docks any floating surface (see engine/cable). */
  patch: (side: PairSide) => void;
  /** Back to floating middle. Both unbind gestures — Escape and click-away — call exactly this. */
  unbind: () => void;
  /** Float or dock a surface; floating the concierge unbinds. */
  overlayTo: (overlay: OverlaySurface) => void;
}

export const useCableStore = create<CableStore>((set) => ({
  ...CABLE_REST,
  // `set` with the reducer's own return keeps zustand's shallow equality meaningful: the reducers
  // return the SAME object for a no-op, so an inert gesture writes nothing new and subscribers
  // (the shell root, the concierge column) do not re-render.
  patch: (side) => set((s) => patchCable(s, side)),
  unbind: () => set((s) => unbindCable(s)),
  overlayTo: (overlay) => set((s) => setOverlay(s, overlay)),
}));

/** Reset to rest. Tests only — the store is a module singleton shared across cases. */
export function resetCable(): void {
  useCableStore.setState({ ...CABLE_REST });
}
