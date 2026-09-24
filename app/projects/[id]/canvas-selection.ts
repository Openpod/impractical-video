export type CanvasSelection = {
  ids: string[];
  primaryId: string | null;
};

export type CanvasModifierSelectionIntent = {
  additive: boolean;
  range: boolean;
  targetId: string;
};

function orderedUnique(ids: string[]) {
  return [...new Set(ids)];
}

export function captureCanvasModifierSelectionIntent({
  ctrlKey,
  metaKey,
  shiftKey,
  targetId,
}: {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  targetId: string;
}): CanvasModifierSelectionIntent | null {
  const additive = metaKey || ctrlKey;
  const range = shiftKey;
  return additive || range ? { additive, range, targetId } : null;
}

export function preservesCanvasSelectionOnFocus(
  intent: CanvasModifierSelectionIntent | null,
  targetId: string,
) {
  return intent?.targetId === targetId;
}

export function nextCanvasSelection({
  additive,
  allIds,
  currentIds,
  primaryId,
  range,
  targetId,
}: {
  additive: boolean;
  allIds: string[];
  currentIds: string[];
  primaryId: string | null;
  range: boolean;
  targetId: string;
}): CanvasSelection {
  const validIds = new Set(allIds);
  const current = orderedUnique(currentIds.filter((id) => validIds.has(id)));

  if (range) {
    const anchorId =
      primaryId && validIds.has(primaryId)
        ? primaryId
        : (current[current.length - 1] ?? targetId);
    const anchorIndex = allIds.indexOf(anchorId);
    const targetIndex = allIds.indexOf(targetId);
    const rangeIds =
      anchorIndex >= 0 && targetIndex >= 0
        ? allIds.slice(
            Math.min(anchorIndex, targetIndex),
            Math.max(anchorIndex, targetIndex) + 1,
          )
        : [targetId];
    return {
      ids: orderedUnique([...current, ...rangeIds]),
      primaryId: targetId,
    };
  }

  if (additive) {
    if (current.includes(targetId)) {
      const ids = current.filter((id) => id !== targetId);
      const nextPrimary =
        primaryId && primaryId !== targetId && ids.includes(primaryId)
          ? primaryId
          : (ids[ids.length - 1] ?? null);
      return { ids, primaryId: nextPrimary };
    }
    return {
      ids: [...current, targetId],
      primaryId: targetId,
    };
  }

  return { ids: [targetId], primaryId: targetId };
}

export function isCanvasCardDeletable(card: { path: string }) {
  return /^(clips|keyframes|uploads)\/[^/]+\.md$/.test(card.path);
}

export function areCanvasCardsDeletable(cards: Array<{ path: string }>) {
  return cards.length > 0 && cards.every(isCanvasCardDeletable);
}
