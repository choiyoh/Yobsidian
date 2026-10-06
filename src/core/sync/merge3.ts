/**
 * Line-based three-way merge (the same idea as `git merge-file` / diff3).
 *
 * `base` is the text both sides started from; `local` and `remote` are the two edited
 * versions. Returns the merged text, or `null` when both sides changed the same lines
 * differently (or the texts are too large to diff cheaply), in which case the caller
 * keeps both versions instead of guessing.
 */
export function merge3(base: string, local: string, remote: string): string | null {
  if (local === remote) return local;
  if (local === base) return remote;
  if (remote === base) return local;

  const b = splitLines(base);
  const l = splitLines(local);
  const r = splitLines(remote);
  const mapL = matchLines(b, l);
  const mapR = matchLines(b, r);
  if (!mapL || !mapR) return null;

  const out: string[] = [];
  let bi = 0;
  let li = 0;
  let ri = 0;

  const hunk = (bEnd: number, lEnd: number, rEnd: number): boolean => {
    const bs = b.slice(bi, bEnd);
    const ls = l.slice(li, lEnd);
    const rs = r.slice(ri, rEnd);
    if (same(ls, bs)) out.push(...rs);
    else if (same(rs, bs) || same(ls, rs)) out.push(...ls);
    else return false;
    return true;
  };

  for (let i = 0; i < b.length; i++) {
    const a = mapL[i]!;
    const c = mapR[i]!;
    if (a < 0 || c < 0) continue; // changed on at least one side: part of the next hunk
    if (!hunk(i, a, c)) return null;
    out.push(b[i]!);
    bi = i + 1;
    li = a + 1;
    ri = c + 1;
  }
  if (!hunk(b.length, l.length, r.length)) return null;
  return out.join("");
}

/** Split keeping each line's own line ending, so joining restores the text exactly. */
function splitLines(text: string): string[] {
  return text === "" ? [] : text.split(/(?<=\n)/);
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

const MAX_CELLS = 4_000_000;

/** For each line of `a`, the index of the matching line in `b` (longest common subsequence) or -1. */
function matchLines(a: string[], b: string[]): Int32Array | null {
  const map = new Int32Array(a.length).fill(-1);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) map[start] = start, start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
    map[endA] = endB;
  }
  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0) return map;
  if ((n + 1) * (m + 1) > MAX_CELLS) return null;

  // dp[i][j] = LCS length of a[start+i..endA) and b[start+j..endB)
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[start + i] === b[start + j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) {
      map[start + i] = start + j;
      i++;
      j++;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) i++;
    else j++;
  }
  return map;
}
