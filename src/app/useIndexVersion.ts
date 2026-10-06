import { useSyncExternalStore } from "react";
import type { NoteIndex } from "@/core/index";

/** Re-render whenever the note index changes. Returns the index version, usable as a memo dependency. */
export function useIndexVersion(index: NoteIndex): number {
  return useSyncExternalStore(index.subscribe.bind(index), () => index.version);
}
