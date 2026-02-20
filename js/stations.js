// Station search + favorites extracted from main.js
// Keep behavior identical; only move code for readability.

export function createStationHandlers({
  ref,
  computed,
  watch,
  axios,
  apiBase,
  mainSearchQuery,
  s1Query,
  s2Query,
  s1Results,
  s2Results,
  s1AbortController,
  s2AbortController,
  station1,
  station2,
  starredStations,
  isShowingFavorites,
  updateMapForStations,
  fetchDepartures,
}) {
  // Favorites
  const isStarred = (id) => starredStations.value.some((s) => s.id === id);

  const toggleStar = (station) => {
    if (isStarred(station.id)) {
      starredStations.value = starredStations.value.filter((s) => s.id !== station.id);
    } else {
      starredStations.value.push({
        id: station.id,
        name: station.name,
        location: station.location,
        type: station.type,
      });
    }
    localStorage.setItem('bvg_fav_stations', JSON.stringify(starredStations.value));
  };

  const showFavorites = () => {
    if (!mainSearchQuery.value && starredStations.value.length > 0) {
      isShowingFavorites.value = true;
      s1Results.value = [];
    }
  };

  const displayResults = computed(() => {
    // Use mainSearchQuery for display logic in the main dropdown
    if (mainSearchQuery.value && s1Results.value.length > 0) return s1Results.value;
    if (!mainSearchQuery.value && starredStations.value.length > 0) return starredStations.value;
    return [];
  });

  watch(mainSearchQuery, (newVal) => {
    if (!newVal) isShowingFavorites.value = true;
    else isShowingFavorites.value = false;
  });

  // Search
  let searchTimeout;

  const handleSearch = (queryRef, resultsRef, abortRef) => {
    if (searchTimeout) clearTimeout(searchTimeout);
    if (abortRef.value) abortRef.value.abort();

    searchTimeout = setTimeout(async () => {
      if (!queryRef.value) {
        resultsRef.value = [];
        return;
      }

      // Prevent searching for combined station names
      if (queryRef.value.includes(' + ')) {
        return;
      }

      const controller = new AbortController();
      abortRef.value = controller;

      try {
        const res = await axios.get(`${apiBase.value}/locations`, {
          params: { query: queryRef.value, results: 6, stops: true },
          signal: controller.signal,
        });
        resultsRef.value = res.data.filter((s) => s.type === 'stop');
      } catch (e) {
        if (axios.isCancel(e)) return;
        console.error(e);
      }
    }, 300);
  };

  const onMainInput = () => {
    // When user types in main, we assume they are searching for a new station (Slot 1)
    // This syncs the input to s1Query to trigger the existing search logic
    s1Query.value = mainSearchQuery.value;
    handleSearch(s1Query, s1Results, s1AbortController);
  };

  const onS1Input = () => {
    handleSearch(s1Query, s1Results, s1AbortController);
  };

  const onS2Input = () => {
    handleSearch(s2Query, s2Results, s2AbortController);
  };

  const selectStation = (station) => {
    // When selecting from main search, we assume single station mode or resetting slot 1
    station1.value = station;
    station2.value = null; // Clear second station
    s1Results.value = [];
    updateMapForStations();
    fetchDepartures();
  };

  const setStation = (slot, station) => {
    if (slot === 1) {
      station1.value = station;
      s1Results.value = [];
    } else {
      station2.value = station;
      s2Results.value = [];
    }
    updateMapForStations();
    fetchDepartures();
  };

  const clearStation = (slot) => {
    if (slot === 1) {
      station1.value = null;
      s1Results.value = [];
    } else {
      station2.value = null;
      s2Query.value = '';
      s2Results.value = [];
    }
    updateMapForStations();
    fetchDepartures();
  };

  const resetStations = () => {
    station1.value = null;
    station2.value = null;
    mainSearchQuery.value = '';
    s1Query.value = '';
    s2Query.value = '';
    s1Results.value = [];
    s2Results.value = [];
    updateMapForStations();
    fetchDepartures();
  };

  return {
    // favorites
    isStarred,
    toggleStar,
    showFavorites,
    displayResults,

    // search
    handleSearch,
    onMainInput,
    onS1Input,
    onS2Input,

    // station selection
    selectStation,
    setStation,
    clearStation,
    resetStations,
  };
}
