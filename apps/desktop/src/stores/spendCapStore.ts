// The per-agent estimated-spend cap the user sets (bead ).
//
// ONE number, persisted, and OFF by default — `null` means no cap, which is what every install
// starts at and stays at until someone types a figure. That default is deliberate: a cap that
// arrives pre-armed would start calling agents "over budget" against a threshold nobody chose.
//
// Every read goes through `normalizeCapUsd`, so a corrupted or hand-edited persisted value (a
// string, `NaN`, `0`, a negative) reads as OFF rather than as a $0 cap that condemns every agent on
// the pane. Failing towards "no cap" is the safe direction here: the failure of an alert is a
// missing warning, and the failure of a bad cap is a screen of false alarms nobody can clear.
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { normalizeCapUsd } from "../engine/agentSpend";

export interface SpendCapState {
  /** The per-agent cap in USD over the pane's window, or `null` for no cap. */
  capUsd: number | null;
  /** Set (or, with `null`/0/NaN, clear) the cap. */
  setCapUsd: (value: number | null) => void;
}

export const SPEND_CAP_PERSIST_KEY = "sparkle.spendCap.v1";

export const useSpendCapStore = create<SpendCapState>()(
  persist(
    (set) => ({
      capUsd: null,
      setCapUsd: (value) => set({ capUsd: normalizeCapUsd(value) }),
    }),
    {
      name: SPEND_CAP_PERSIST_KEY,
      // Rehydration is the other door into this value, and it is the one a bad number comes
      // through: a hand-edited or half-written localStorage entry never passes `setCapUsd`.
      merge: (persisted, current) => ({
        ...current,
        capUsd: normalizeCapUsd((persisted as Partial<SpendCapState> | undefined)?.capUsd),
      }),
    },
  ),
);
