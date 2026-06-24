// uiStore — small persisted UI preferences (not project/agent data). Currently just the
// composer height, so the size you drag it to sticks across tabs and relaunches.
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export const COMPOSER_MIN = 64;
export const COMPOSER_DEFAULT = 96;

interface UiState {
  composerHeight: number;
  setComposerHeight: (h: number) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      composerHeight: COMPOSER_DEFAULT,
      setComposerHeight: (h) => set({ composerHeight: Math.max(COMPOSER_MIN, h) }),
    }),
    { name: "sparkle-ui", storage: createJSONStorage(() => localStorage) },
  ),
);
