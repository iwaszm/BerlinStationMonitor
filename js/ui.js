// UI helpers extracted from main.js
// Keep behavior identical; only move code for readability.

export function createUiHandlers({
  computed,
  nextTick,
  windowObj,
  sidebarRef,
  infoSectionRef,
  infoState,
  isDragging,
  dragStartY,
  dragStartHeight,
  pullStartY,
  pullDistance,
  isRefreshing,
  pullThreshold,
  fetchDepartures,
  mapGet,
}) {
  const pullOpacity = computed(() => Math.min(pullDistance.value / pullThreshold, 1));
  const pullTranslate = computed(() => Math.min(pullDistance.value, pullThreshold));

  const toggleInfoState = (e) => {
    if (isDragging.value) return;
    if (infoState.value === 2) {
      infoState.value = 0;
    } else if (infoState.value === 0) {
      infoState.value = 1;
    } else {
      infoState.value = 2;
    }
  };

  const onDragStart = (e) => {
    isDragging.value = true;
    dragStartY.value = e.touches[0].clientY;
    const rect = sidebarRef.value.getBoundingClientRect();
    dragStartHeight.value = rect.height;
  };

  const onDragMove = (e) => {
    if (!isDragging.value) return;
    const currentY = e.touches[0].clientY;
    const deltaY = dragStartY.value - currentY;
    let newHeight = dragStartHeight.value + deltaY;

    const maxHeight = windowObj.innerHeight;
    const minHeight = 130;

    if (newHeight > maxHeight) newHeight = maxHeight;
    if (newHeight < minHeight) newHeight = minHeight;

    sidebarRef.value.style.height = `${newHeight}px`;
  };

  const onDragEnd = (e) => {
    isDragging.value = false;
    const finalHeight = parseFloat(sidebarRef.value.style.height) || dragStartHeight.value;
    sidebarRef.value.style.height = '';

    const windowH = windowObj.innerHeight;
    const ratio = finalHeight / windowH;

    if (ratio < 0.35) {
      infoState.value = 0;
    } else if (ratio < 0.85) {
      infoState.value = 1;
    } else {
      infoState.value = 2;
    }
  };

  // Pull-to-refresh
  const onPullStart = (e) => {
    if (infoState.value !== 2) return;
    if (infoSectionRef.value.scrollTop === 0) {
      pullStartY.value = e.touches[0].clientY;
    }
  };

  const onPullMove = (e) => {
    if (infoState.value !== 2 || pullStartY.value === 0) return;
    const currentY = e.touches[0].clientY;
    const diff = currentY - pullStartY.value;

    if (infoSectionRef.value.scrollTop === 0 && diff > 0) {
      if (e.cancelable) e.preventDefault();
      pullDistance.value = diff * 0.5;
    } else {
      pullDistance.value = 0;
    }
  };

  const onPullEnd = () => {
    if (pullDistance.value > pullThreshold) {
      isRefreshing.value = true;
      fetchDepartures(true).then(() => {
        setTimeout(() => {
          isRefreshing.value = false;
          pullDistance.value = 0;
        }, 500);
      });
    } else {
      pullDistance.value = 0;
    }
    pullStartY.value = 0;
  };

  const toggleMap = (showMap) => {
    showMap.value = !showMap.value;
    if (showMap.value) {
      nextTick(() => {
        const map = mapGet();
        if (map) {
          map.invalidateSize();
        }
      });
    }
  };

  const zoomIn = () => {
    const map = mapGet();
    if (map) map.zoomIn();
  };

  const zoomOut = () => {
    const map = mapGet();
    if (map) map.zoomOut();
  };

  return {
    pullOpacity,
    pullTranslate,
    toggleInfoState,
    onDragStart,
    onDragMove,
    onDragEnd,
    onPullStart,
    onPullMove,
    onPullEnd,
    toggleMap,
    zoomIn,
    zoomOut,
  };
}
