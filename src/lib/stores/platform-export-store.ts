import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_VIDEO_FRAMING, parseVideoFraming, type VideoFraming } from "@/lib/video-framing";
import { PLATFORM_SPECS } from "@/lib/platform-specs";

const platforms = Object.keys(PLATFORM_SPECS);
interface ExportSettings {
  framing: VideoFraming;
  selected: string[];
  setFraming: (framing: VideoFraming) => void;
  setSelected: (selected: string[]) => void;
}
export const usePlatformExportStore = create<ExportSettings>()(persist((set) => ({
  framing: { ...DEFAULT_VIDEO_FRAMING }, selected: platforms,
  setFraming: framing => set({ framing }), setSelected: selected => set({ selected }),
}), {
  name: "clipforge-platform-export",
  merge: (saved, current) => {
    const value = saved as Partial<ExportSettings> | undefined;
    let framing = current.framing;
    try { if (value?.framing) framing = parseVideoFraming(value.framing); } catch { /* ignore outdated preferences */ }
    return { ...current, framing, selected: Array.isArray(value?.selected) ? platforms.filter(p => value.selected!.includes(p)) : current.selected };
  },
}));
