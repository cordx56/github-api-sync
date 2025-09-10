import { diffChars } from "diff";

/**
 * 3-way line-based merge.
 * - Returns merged text when changes don't conflict.
 * - Others return null
 */
export const threeWayMerge = (
  base: string,
  ours: string,
  theirs: string,
): string | null => {
  // Fast-path checks
  if (ours === theirs) return ours;
  if (ours === base) return theirs;
  if (theirs === base) return ours;

  type Edit = { start: number; end: number; newText: string };

  const buildEdits = (from: string, to: string): Edit[] => {
    const parts = diffChars(from, to);
    const out: Edit[] = [];
    let baseIdx = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i] as any;
      if (p.added) {
        out.push({ start: baseIdx, end: baseIdx, newText: p.value });
        continue;
      }
      if (p.removed) {
        const removedCount = p.value.length;
        const next = parts[i + 1];
        if (next && next.added) {
          out.push({
            start: baseIdx,
            end: baseIdx + removedCount,
            newText: next.value,
          });
          i++; // consume next
        } else {
          out.push({
            start: baseIdx,
            end: baseIdx + removedCount,
            newText: "",
          });
        }
        baseIdx += removedCount;
        continue;
      }
      // Unchanged
      baseIdx += p.value.length;
    }
    return out;
  };

  const ourEdits = buildEdits(base, ours);
  const theirEdits = buildEdits(base, theirs);

  let result = "";
  let pos = 0; // current index in base
  let oi = 0;
  let ti = 0;

  const copyUntil = (end: number) => {
    if (pos < end) {
      result += base.slice(pos, end);
      pos = end;
    }
  };

  const overlaps = (a: Edit, b: Edit): boolean => {
    if (a.start === b.start) return true; // concurrent insertion/replacement at same anchor
    return Math.max(a.start, b.start) < Math.min(a.end, b.end);
  };

  while (oi < ourEdits.length || ti < theirEdits.length) {
    const oe = oi < ourEdits.length ? ourEdits[oi] : null;
    const te = ti < theirEdits.length ? theirEdits[ti] : null;
    if (!oe && !te) break;

    const nextStart = Math.min(
      oe ? oe.start : Number.POSITIVE_INFINITY,
      te ? te.start : Number.POSITIVE_INFINITY,
    );
    copyUntil(nextStart);

    const oursAtStart = oe && oe.start === nextStart ? oe : null;
    const theirsAtStart = te && te.start === nextStart ? te : null;

    if (oursAtStart && theirsAtStart) {
      const sameRange = oursAtStart.end === theirsAtStart.end;
      const sameContent = oursAtStart.newText === theirsAtStart.newText;
      if (!sameRange || !sameContent) return null; // conflict
      result += oursAtStart.newText;
      pos = oursAtStart.end;
      oi++;
      ti++;
      continue;
    }

    if (oursAtStart && !theirsAtStart) {
      if (te && overlaps(oursAtStart, te)) return null;
      result += oursAtStart.newText;
      pos = oursAtStart.end;
      oi++;
      continue;
    }

    if (theirsAtStart && !oursAtStart) {
      if (oe && overlaps(theirsAtStart, oe)) return null;
      result += theirsAtStart.newText;
      pos = theirsAtStart.end;
      ti++;
      continue;
    }
  }

  copyUntil(base.length);
  return result;
};
