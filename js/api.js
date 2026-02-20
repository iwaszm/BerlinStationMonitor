// API helpers extracted from main.js
// Keep behavior identical: endpoints, axios usage, error handling.

export function installAxiosInterceptors(axios, networkError) {
  axios.interceptors.response.use(
    (response) => {
      if (networkError.value) networkError.value = false;
      return response;
    },
    (error) => {
      if (
        error.message === "Network Error" ||
        error.code === "ERR_NETWORK" ||
        (error.response && error.response.status >= 500)
      ) {
        networkError.value = true;
      }
      return Promise.reject(error);
    }
  );
}

export function createBvgApi({
  axios,
  apiBase,
  duration,
  watchedStations,
  departuresRaw,
  loading,
  startRadarLoop,
  getBoundingBox,
  radarAbortControllerBox,
  isRadarActive,
  radarError,
  lastRadarData,
  showMap,
  updateVehicleMarkers,
}) {
  const fetchDepartures = async (silent = false) => {
    if (watchedStations.value.length === 0) {
      departuresRaw.value = [];
      return;
    }

    if (!silent) {
      loading.value = true;
      departuresRaw.value = []; // Reset on new search/station change
    }

    try {
      const promises = watchedStations.value.map((station) =>
        axios
          .get(`${apiBase.value}/stops/${station.id}/departures`, {
            params: { duration: duration.value, results: 50 },
          })
          .then((res) => {
            const deps = res.data.departures || [];
            return deps.map((d) => ({
              ...d,
              stationName: station.name,
              uniqueId: d.tripId + "_" + station.id,
            }));
          })
      );

      const results = await Promise.all(promises);
      const allDeps = results.flat();
      departuresRaw.value = allDeps;
      startRadarLoop();
    } catch (e) {
      console.error(e);
      if (!silent) departuresRaw.value = [];
    } finally {
      if (!silent) loading.value = false;
    }
  };

  const fetchRadar = async () => {
    if (watchedStations.value.length === 0) return;

    if (radarAbortControllerBox.current) {
      radarAbortControllerBox.current.abort();
    }
    radarAbortControllerBox.current = new AbortController();
    const signal = radarAbortControllerBox.current.signal;

    const fetchPromises = watchedStations.value.map((station) => {
      if (!station.location) return Promise.resolve([]);
      const { latitude, longitude } = station.location;
      const bbox = getBoundingBox(latitude, longitude, 2.0);
      return axios
        .get(`${apiBase.value}/radar`, {
          params: {
            north: bbox.north,
            west: bbox.west,
            south: bbox.south,
            east: bbox.east,
            results: 256,
            duration: 60,
            frames: 3,
            polylines: true,
          },
          signal: signal,
        })
        .then((res) => {
          return Array.isArray(res.data) ? res.data : res.data.movements || [];
        })
        .catch((e) => {
          if (axios.isCancel(e)) throw e;
          console.warn(`Radar fetch failed for ${station.name}`, e);
          return [];
        });
    });

    try {
      const results = await Promise.all(fetchPromises);
      const vehicleMap = new Map();
      results
        .flat()
        .forEach((v) => {
          if (v && v.tripId) {
            vehicleMap.set(v.tripId, v);
          }
        });
      const combinedVehicles = Array.from(vehicleMap.values());
      isRadarActive.value = true;
      radarError.value = false;
      lastRadarData.value = combinedVehicles;
      if (showMap.value) updateVehicleMarkers(combinedVehicles);
    } catch (e) {
      if (axios.isCancel(e)) return;
      console.warn("Radar update skipped/failed");
    }
  };

  return { fetchDepartures, fetchRadar };
}
