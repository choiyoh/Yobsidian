import { useCallback, useState } from "react";

export interface Location {
  path: string;
  /** Where to scroll to after opening. `nonce` makes repeat jumps to the same heading fire again. */
  reveal?: { heading?: string; block?: string; nonce: number };
}

interface Stack {
  entries: Location[];
  pos: number;
}

let nonce = 0;

/** Browser-style back/forward history over opened notes. */
export function useNavigation(initial: string | null) {
  const [stack, setStack] = useState<Stack>({ entries: initial ? [{ path: initial }] : [], pos: initial ? 0 : -1 });

  const go = useCallback((path: string, reveal?: { heading?: string; block?: string }) => {
    setStack((s) => {
      const loc: Location = { path, reveal: reveal ? { ...reveal, nonce: ++nonce } : undefined };
      const current = s.entries[s.pos];
      // Jumping within the open note just updates its scroll target instead of piling up history.
      if (current?.path === path) {
        const entries = [...s.entries];
        entries[s.pos] = loc;
        return { ...s, entries };
      }
      const entries = [...s.entries.slice(0, s.pos + 1), loc];
      return { entries, pos: entries.length - 1 };
    });
  }, []);

  const step = useCallback((delta: number) => {
    setStack((s) => {
      const pos = s.pos + delta;
      return pos < 0 || pos >= s.entries.length ? s : { ...s, pos };
    });
  }, []);

  /** Keep history valid after files move or disappear. `to === null` removes the path. */
  const remap = useCallback((map: (path: string) => string | null) => {
    setStack((s) => {
      let pos = s.pos;
      const entries: Location[] = [];
      s.entries.forEach((e, i) => {
        const path = map(e.path);
        if (path === null) {
          if (i <= s.pos) pos--;
          return;
        }
        const prev = entries[entries.length - 1];
        if (prev && prev.path === path) {
          if (i <= s.pos) pos--;
          return;
        }
        entries.push({ ...e, path });
      });
      return { entries, pos: Math.max(Math.min(pos, entries.length - 1), entries.length ? 0 : -1) };
    });
  }, []);

  return {
    current: stack.entries[stack.pos] as Location | undefined,
    go,
    back: () => step(-1),
    forward: () => step(1),
    canBack: stack.pos > 0,
    canForward: stack.pos < stack.entries.length - 1,
    remap,
  };
}
