export const TAB_REORDER_START_DISTANCE_DIP = 4;

export interface TabReorderSession {
  readonly panelId: string;
  readonly startX: number;
  readonly startY: number;
  readonly originalIndex: number;
  readonly currentIndex: number;
  readonly started: boolean;
}

export interface TabReorderCompletion {
  readonly targetIndex: number | null;
  readonly suppressClick: boolean;
}

export function createTabReorderSession(
  panelId: string,
  startX: number,
  startY: number,
  sourceIndex: number,
): TabReorderSession {
  return {
    panelId,
    startX,
    startY,
    originalIndex: sourceIndex,
    currentIndex: sourceIndex,
    started: false,
  };
}

export function updateTabReorderSession(
  session: TabReorderSession,
  clientX: number,
  clientY: number,
  tabCenters: readonly number[],
): TabReorderSession {
  const started = session.started || (
    Math.abs(clientX - session.startX) + Math.abs(clientY - session.startY)
      >= TAB_REORDER_START_DISTANCE_DIP
  );
  if (!started) return session;
  const currentIndex = resolveTabReorderTargetIndex(
    clientX,
    session.currentIndex,
    tabCenters,
  );
  if (session.started && currentIndex === session.currentIndex) return session;
  return { ...session, started: true, currentIndex };
}

export function completeTabReorderSession(
  session: TabReorderSession,
  cancelled: boolean,
): TabReorderCompletion {
  return {
    targetIndex: !cancelled
      && session.started
      && session.currentIndex !== session.originalIndex
      ? session.currentIndex
      : null,
    suppressClick: session.started,
  };
}

export function reorderPanelIds(
  panelIds: readonly string[],
  panelId: string,
  targetIndex: number,
): readonly string[] {
  if (!Number.isSafeInteger(targetIndex)) return panelIds;
  const sourceIndex = panelIds.indexOf(panelId);
  if (sourceIndex < 0) return panelIds;
  const destination = Math.min(
    panelIds.length - 1,
    Math.max(0, targetIndex),
  );
  if (destination === sourceIndex) return panelIds;
  const reordered = [...panelIds];
  const [movedPanelId] = reordered.splice(sourceIndex, 1);
  if (movedPanelId === undefined) return panelIds;
  reordered.splice(destination, 0, movedPanelId);
  return reordered;
}

function resolveTabReorderTargetIndex(
  clientX: number,
  currentIndex: number,
  tabCenters: readonly number[],
): number {
  if (tabCenters.length === 0) return currentIndex;
  let targetIndex = Math.min(
    tabCenters.length - 1,
    Math.max(0, currentIndex),
  );
  while (
    targetIndex < tabCenters.length - 1
    && clientX > (tabCenters[targetIndex + 1] ?? Number.POSITIVE_INFINITY)
  ) {
    targetIndex += 1;
  }
  while (
    targetIndex > 0
    && clientX < (tabCenters[targetIndex - 1] ?? Number.NEGATIVE_INFINITY)
  ) {
    targetIndex -= 1;
  }
  return targetIndex;
}
