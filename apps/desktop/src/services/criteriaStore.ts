// Persisted store for MANUAL criterion ticks in the Definable Done & Delivered feature. Auto
// criteria are observed from git/PR/release state (criteriaEval.ts); manual criteria are ticked by
// a human, and those ticks live here — keyed beadId → stageKey → criterionIndex → boolean.
//
// PERSISTENCE (v1): local-only, via zustand's `persist` middleware into localStorage (the same
// pattern as suggestionStore/settingsStore). This is intentionally NOT synced to the repo or across
// machines yet — a tick is a personal, per-machine annotation until the "confirm the move" applies
// the real `bd` status. Documented as a v1 limitation; a future unit may promote it to shared state.
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { StageKey } from "./stageDefs";

/** Per-bead map: stageKey → (criterion index → ticked?). Partial because a bead may have ticks for
 *  only one stage, and indices are sparse (only ticked/toggled ones are stored). */
type BeadTicks = Partial<Record<StageKey, Record<number, boolean>>>;

interface CriteriaStore {
  /** beadId → stage ticks. */
  ticks: Record<string, BeadTicks>;
  isChecked: (beadId: string, key: StageKey, index: number) => boolean;
  setChecked: (beadId: string, key: StageKey, index: number, value: boolean) => void;
  toggle: (beadId: string, key: StageKey, index: number) => void;
}

export const useCriteriaStore = create<CriteriaStore>()(
  persist(
    (set, get) => ({
      ticks: {},
      isChecked: (beadId, key, index) => get().ticks[beadId]?.[key]?.[index] === true,
      setChecked: (beadId, key, index, value) =>
        set((s) => {
          const bead = s.ticks[beadId] ?? {};
          const stage = bead[key] ?? {};
          return {
            ticks: {
              ...s.ticks,
              [beadId]: { ...bead, [key]: { ...stage, [index]: value } },
            },
          };
        }),
      toggle: (beadId, key, index) =>
        get().setChecked(beadId, key, index, !get().isChecked(beadId, key, index)),
    }),
    { name: "sparkle-criteria-ticks", storage: createJSONStorage(() => localStorage), version: 1 },
  ),
);
