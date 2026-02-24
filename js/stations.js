// Station search + favorites (+ nearby via geolocation) extracted from main.js
// Keep behavior consistent with existing UX; minimize side effects.

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
  // optional: update map with user location
  setUserLocation,
}) {
  // ------------------------------
  // Dropdown visibility (main search)
  // ------------------------------
  const isMainDropdownOpen = ref(false);
  const nearbyStations = ref([]);
  const isGeoEnabled = ref(false);
  const lastUserLocation = ref(null); // { latitude, longitude, ts }

  const openMainDropdown = () => {
    isMainDropdownOpen.value = true;
  };

  const closeMainDropdownSoon = () => {
    // Delay so clicks on dropdown items can register
    setTimeout(() => {
      isMainDropdownOpen.value = false;
    }, 180);
  };

  // ------------------------------
  // Favorites
  // ------------------------------
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

  // Main search focus/blur
  const onMainFocus = async () => {
    openMainDropdown();

    if (!mainSearchQuery.value && starredStations.value.length > 0) {
      isShowingFavorites.value = true;
    }

    // Note: Search dropdown no longer shows favorites/nearby (dashboard handles that).
  };

  const isLocating = ref(false);

  const onMainBlur = () => {
    // If a locate click is in progress, keep dropdown open long enough to show nearby results
    if (isLocating.value) return;
    closeMainDropdownSoon();
  };

  // For backward-compat: keep showFavorites used by template (now just opens dropdown)
  const showFavorites = () => {
    onMainFocus();
  };

  const displaySearchResults = computed(() => {
    if (mainSearchQuery.value && s1Results.value.length > 0) return s1Results.value;
    return [];
  });

  const displayFavoriteResults = computed(() => []);
  const displayNearbyResults = computed(() => []);

  const isMainDropdownVisible = computed(() => {
    return displaySearchResults.value.length > 0;
  });

  watch(mainSearchQuery, (newVal) => {
    if (!newVal) {
      isShowingFavorites.value = true;
    } else {
      isShowingFavorites.value = false;
      // When typing, ensure dropdown stays open.
      openMainDropdown();
    }
  });

  // ------------------------------
  // Search (BVG locations)
  // ------------------------------
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
      if (queryRef.value.includes(' + ')) return;

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
    s1Query.value = mainSearchQuery.value;
    handleSearch(s1Query, s1Results, s1AbortController);
  };

  const onS1Input = () => {
    handleSearch(s1Query, s1Results, s1AbortController);
  };

  const onS2Input = () => {
    handleSearch(s2Query, s2Results, s2AbortController);
  };

  // ------------------------------
  // Geolocation -> nearby stations
  // ------------------------------
  const fetchNearbyStations = async ({ latitude, longitude }) => {
    const res = await axios.get(`${apiBase.value}/locations/nearby`, {
      params: {
        latitude,
        longitude,
        distance: 1000,
        results: 80,
        stops: true,
        poi: false,
      },
    });

    const stops = (res.data || []).filter((s) => (s.type || '') === 'stop');
    nearbyStations.value = stops;
  };

  const onLocateClick = async () => {
    try {
      isLocating.value = true;
      openMainDropdown();

      if (!('geolocation' in navigator)) {
        console.warn('Geolocation not available');
        return;
      }

      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 8000,
          maximumAge: 30_000,
        });
      });

      const latitude = pos.coords.latitude;
      const longitude = pos.coords.longitude;

      isGeoEnabled.value = true;
      lastUserLocation.value = { latitude, longitude, ts: Date.now() };

      if (typeof setUserLocation === 'function') {
        setUserLocation({ latitude, longitude });
      }

      await fetchNearbyStations({ latitude, longitude });

      // Ensure favorites header can appear when query is empty
      if (starredStations.value.length > 0) {
        isShowingFavorites.value = true;
      }

      // Keep dropdown open a bit so results are visible
      setTimeout(() => {
        isLocating.value = false;
      }, 600);
    } catch (e) {
      console.warn('Geolocation failed', e);
      isLocating.value = false;
    }
  };

  // ------------------------------
  // Station selection
  // ------------------------------
  const selectStation = (station) => {
    station1.value = station;
    station2.value = null;
    s1Results.value = [];
    updateMapForStations();
    fetchDepartures();
    // Close dropdown after selection
    isMainDropdownOpen.value = false;
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
    isMainDropdownOpen.value = false;
  };

  const clearStation = (slot) => {
    if (slot === 1) {
      // Slot 2 only makes sense when slot 1 is set.
      // Clearing slot 1 must also clear slot 2 and reset departures.
      station1.value = null;
      station2.value = null;
      mainSearchQuery.value = '';
      s1Query.value = '';
      s2Query.value = '';
      s1Results.value = [];
      s2Results.value = [];
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

  const enableGeolocation = async () => {
    if (!('geolocation' in navigator)) {
      console.warn('Geolocation not available');
      return;
    }

    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 8000,
        maximumAge: 30_000,
      });
    });

    const latitude = pos.coords.latitude;
    const longitude = pos.coords.longitude;

    isGeoEnabled.value = true;
    lastUserLocation.value = { latitude, longitude, ts: Date.now() };

    if (typeof setUserLocation === 'function') {
      setUserLocation({ latitude, longitude });
    }
  };

  const refreshNearby = async ({ ensureEnabled = false } = {}) => {
    try {
      if (ensureEnabled && !isGeoEnabled.value) {
        await enableGeolocation();
      }
      if (!isGeoEnabled.value || !lastUserLocation.value) return;
      await fetchNearbyStations(lastUserLocation.value);
    } catch (e) {
      console.warn('Failed to refresh nearby stops', e);
    }
  };

  return {
    // favorites
    isStarred,
    toggleStar,
    showFavorites,

    // main dropdown
    onMainFocus,
    onMainBlur,
    isMainDropdownVisible,
    displaySearchResults,
    displayFavoriteResults,
    displayNearbyResults,

    // expose nearby state for dashboard
    nearbyStations,
    isGeoEnabled,
    refreshNearby,

    // search
    handleSearch,
    onMainInput,
    onS1Input,
    onS2Input,

    // locate
    onLocateClick,

    // station selection
    selectStation,
    setStation,
    clearStation,
    resetStations,
  };
}
