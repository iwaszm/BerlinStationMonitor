import { translations, API_ENDPOINTS, PRODUCT_COLORS, DARK_TILES, LIGHT_TILES } from './constants.js';
import { cleanName, escapeHtml, getBoundingBox } from './utils.js';
import { createUiHandlers } from './ui.js';
import { createStationHandlers } from './stations.js';

// --- iOS 12 / iPhone 6 Polyfill Check ---
    if (typeof ResizeObserver === 'undefined') {
        window.ResizeObserver = class ResizeObserver {
            observe() {}
            unobserve() {}
            disconnect() {}
        };
    }

    // Debug-friendly fatal error overlay (helps diagnose blank screen in production)
    const showFatal = (err) => {
        try {
            const msg = (err && (err.stack || err.message)) ? (err.stack || err.message) : String(err);
            const el = document.createElement('div');
            el.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#111;color:#fff;padding:16px;overflow:auto;font-family:monospace;font-size:12px;';
            el.innerHTML = '<b>App error</b><pre style="white-space:pre-wrap;">' + msg.replace(/</g,'&lt;') + '</pre>';
            document.body.appendChild(el);
        } catch (_) {}
    };

    window.addEventListener('error', (e) => showFatal(e.error || e.message));
    window.addEventListener('unhandledrejection', (e) => showFatal(e.reason || e));

    const { createApp, ref, onMounted, computed, watch, onUnmounted, nextTick } = Vue;

    createApp({
      setup() {
                // ==============================
        // State
        // ==============================

        const currentTime = ref("");
        const now = ref(new Date());
        
        const currentLang = ref('de');
        const t = computed(() => translations[currentLang.value]);

        const toggleLang = () => {
            currentLang.value = currentLang.value === 'de' ? 'en' : 'de';
        };

        const mainSearchQuery = ref(""); // New variable for Main Search Bar
        const searchQuery = ref(""); 
        const searchResults = ref([]); 
        
        const station1 = ref(null);
        const station2 = ref(null);
        const s1Query = ref("");
        const s2Query = ref("");
        const s1Results = ref([]);
        const s2Results = ref([]);
        
        const s1AbortController = ref(null);
        const s2AbortController = ref(null);
        
        const showMap = ref(true);
        const networkError = ref(false);

        // Mobile: allow hiding the top time bar to maximize dashboard space
        const isTimebarHidden = ref(false); // default: time bar visible
        const toggleTimebar = () => { isTimebarHidden.value = !isTimebarHidden.value; }; 
        
        // Touch Gesture Variables
        const isDragging = ref(false);
        const dragStartY = ref(0);
        const dragStartHeight = ref(0);
        const sidebarRef = ref(null);

        // Pull To Refresh Variables
        const infoSectionRef = ref(null);
        const pullStartY = ref(0);
        const pullDistance = ref(0);
        const isRefreshing = ref(false);
        const pullThreshold = 70; // px

        
        // ==============================
        // API (BVG) + Network
        // ==============================

        const POSTSTADION_STOP_ID = '900002256';
        const POSTSTADION_PREDICTION_LINES = new Set(['123', '142']);

        // --- API Failover Logic REMOVED (Only BVG) ---
        const apiEndpoints = API_ENDPOINTS;
        const currentApiIndex = ref(0);
        const apiBase = computed(() => apiEndpoints[currentApiIndex.value].url);
        const currentApiName = computed(() => apiEndpoints[currentApiIndex.value].name);

        axios.interceptors.response.use(
            response => {
                if (networkError.value) networkError.value = false;
                return response;
            },
            error => {
                if (error.message === 'Network Error' || error.code === 'ERR_NETWORK' || (error.response && error.response.status >= 500)) {
                    networkError.value = true;
                }
                return Promise.reject(error);
            }
        );

        
        // ==============================
        // Derived / Computed
        // ==============================

        const watchedStations = computed(() => {
            const list = [];
            if (station1.value) list.push(station1.value);
            if (station2.value) list.push(station2.value);
            return list;
        });

        
        // ==============================
        // Watchers
        // ==============================

        // Combined watcher for Main Search Display vs Individual Settings Inputs
        watch([station1, station2], ([s1, s2]) => {
            if (s1 && s2) {
                // Main displays combined
                mainSearchQuery.value = `${cleanName(s1.name)} + ${cleanName(s2.name)}`;
                // Inner inputs stay individual
                s1Query.value = cleanName(s1.name);
                s2Query.value = cleanName(s2.name);
            } else if (s1) {
                // Main displays single
                mainSearchQuery.value = cleanName(s1.name);
                s1Query.value = cleanName(s1.name);
            } else {
                mainSearchQuery.value = "";
                s1Query.value = "";
            }
        });

        const starredStations = ref([]); 
        const isShowingFavorites = ref(false);

        // Dashboard (no station selected) tabs
        const dashboardStopsTab = ref('favorites'); // 'nearby' | 'favorites'

        
        const currentTheme = ref('dark'); 
        const isDarkMode = computed(() => currentTheme.value === 'dark' || currentTheme.value === 'led');
        const isLedMode = computed(() => currentTheme.value === 'led');
        const isLargeFont = ref(false); 
        
        const toggleFontSize = () => {
            isLargeFont.value = !isLargeFont.value;
        };
        
        const showSettings = ref(false);
        
        const departuresRaw = ref([]);
        
        const excludedLines = ref(new Set());

        // Terminal filter (only enabled when the line list is small)
        // Structure: { [lineName]: { [terminalName]: true } } where true means excluded
        const terminalExclusions = ref({});

        const loading = ref(false);
        const activeFilters = ref(['suburban', 'subway', 'tram', 'bus', 'regional', 'express']);
        const duration = ref(30);
        const departuresLastUpdated = ref(null);
        const departuresIsStale = ref(false);
        const departuresErrorType = ref(null);
        
        const expandedTripId = ref(null);
        const currentTripStopovers = ref([]);
        const isTripLoading = ref(false);
        const stopoverLimit = ref(5);
        
        const isRadarActive = ref(false);
        const radarError = ref(false);

        const infoState = ref(2); // UPDATED: Default to Full (2)

        const lastRadarData = ref([]);

        let map, baseLayer;
        let routeLayer; // Layer for drawing vehicle routes
        let stationMarkers = [];
        let stationCircles = [];
        let vehicleMarkers = {}; 
        let vehicleTrails = {}; 
        let vehiclePreviousPositions = {};
        let radarInterval; 
        let radarFailureCount = 0;
        let clockTimer = null;
        
        let autoRefreshTimer = null;
        let departuresFailureCount = 0;
        let currentDeparturesCacheKey = '';
        const getRefreshDelay = () => {
          if (departuresFailureCount >= 3) return 120000;
          if (departuresFailureCount >= 1) return 60000;
          return 30000;
        };
        const startDeparturesLoop = () => {
          if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
          if (watchedStations.value.length === 0) return;
          autoRefreshTimer = setTimeout(async () => {
            await fetchDepartures(true);
            startDeparturesLoop();
          }, getRefreshDelay());
        };

        watch(watchedStations, () => {
          startDeparturesLoop();
        }, { deep: true });

        
        let searchTimeout;
        const searchAbortController = ref(null);
        let radarAbortController = null;

        const productColors = PRODUCT_COLORS;

        const createBaseLayer = (styleUrl) => {
          if (L.maplibreGL) {
            return L.maplibreGL({
              style: styleUrl,
              attribution: 'OpenFreeMap &copy; OpenMapTiles Data from OpenStreetMap'
            });
          }
          return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap contributors'
          });
        };

        const updateBaseLayer = () => {
          if (!map) return;
          if (baseLayer) map.removeLayer(baseLayer);
          baseLayer = createBaseLayer(isDarkMode.value ? DARK_TILES : LIGHT_TILES).addTo(map);
        };

        const setTheme = (theme) => {
            currentTheme.value = theme;
        };

        const infoStateClass = computed(() => {
            if (infoState.value === 2) return 'state-full mobile-full'; 
            if (infoState.value === 1) return 'state-half mobile-half';
            return 'state-collapsed mobile-collapsed';
        });

        const sidebarMobileClass = computed(() => {
            if (infoState.value === 2) return 'mobile-full';
            if (infoState.value === 1) return 'mobile-half';
            return 'mobile-collapsed';
        });

        // Arrow indicates the *next* toggle direction for the panel
        const toggleIcon = computed(() => {
            // full -> collapse (up), collapsed/half -> expand (down)
            if (infoState.value === 2) return 'fa-chevron-up';
            return 'fa-chevron-down';
        });

        
        // ==============================
        // UI: Drag + Pull-to-refresh
        // ==============================
        // --- Pull To Refresh Logic ---

        watch(isDarkMode, (newVal) => {
          if (newVal) {
             document.body.classList.remove('light-mode');
          } else {
             document.body.classList.add('light-mode');
          }
          updateBaseLayer();
        });

        watch(infoState, () => {
             setTimeout(() => {
                 if(map) map.invalidateSize();
             }, 350);
        });

        
        // ==============================
        // Lifecycle
        // ==============================

        onMounted(() => {
          if (!document.getElementById("map")) return;
          map = L.map("map", { zoomControl: false }).setView([52.5200, 13.4050], 13);
          
          updateBaseLayer();

          // Create panes for layering
          // Lines go in custom pane
          map.createPane('customRouteLinePane');
          map.getPane('customRouteLinePane').style.zIndex = 450;
          
          // Stops go in higher pane
          map.createPane('customRouteStopsPane');
          map.getPane('customRouteStopsPane').style.zIndex = 500;

          routeLayer = L.layerGroup().addTo(map);

          // Clear route when clicking on map background
          map.on('click', () => {
              if (routeLayer) routeLayer.clearLayers();
          });

          map.on('zoomstart', () => {
              document.querySelectorAll('.leaflet-marker-icon').forEach(el => { el.classList.add('no-transition'); });
          });
          map.on('zoomend', () => {
              setTimeout(() => {
                  document.querySelectorAll('.leaflet-marker-icon').forEach(el => { el.classList.remove('no-transition'); });
              }, 100);
          });
          
          const resizeObserver = new ResizeObserver(() => {
             if(map) map.invalidateSize();
          });
          resizeObserver.observe(document.getElementById('app'));

          clockTimer = setInterval(() => { now.value = new Date(); currentTime.value = now.value.toLocaleTimeString("de-DE"); }, 1000);
          
          try {
            const saved = localStorage.getItem('bvg_fav_stations');
            if (saved) {
              const parsed = JSON.parse(saved);
              starredStations.value = Array.isArray(parsed) ? parsed : [];
            }
          } catch (e) {
            console.warn('Invalid saved favorites, resetting', e);
            localStorage.removeItem('bvg_fav_stations');
            starredStations.value = [];
          }
        });

        onUnmounted(() => {
          if (radarInterval) clearTimeout(radarInterval);
          if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
          if (clockTimer) clearInterval(clockTimer);
        });

        // ==============================
        // Stations: search + favorites
        // ==============================



        const updateMapForStations = () => {
            if (!map) return;
            stationMarkers.forEach(m => map.removeLayer(m));
            stationCircles.forEach(c => map.removeLayer(c));
            stationMarkers = [];
            stationCircles = [];
            
            if (watchedStations.value.length === 0) return;

            const bounds = L.latLngBounds();

            watchedStations.value.forEach(station => {
                if (station.location) {
                    const lat = station.location.latitude;
                    const lon = station.location.longitude;
                    bounds.extend([lat, lon]);

                    const stationIcon = L.divIcon({
                        className: 'station-pos-marker', 
                        iconSize: [20, 20],
                        iconAnchor: [10, 10], 
                        popupAnchor: [0, -10]
                    });

                    const marker = L.marker([lat, lon], { icon: stationIcon })
                        .addTo(map)
                        .bindTooltip(`<div>${escapeHtml(cleanName(station.name))}</div>`, {
                            permanent: true, direction: 'top', offset: [0, -22], className: 'station-tooltip' 
                        });
                    
                    stationMarkers.push(marker);

                    const circle = L.circle([lat, lon], {
                        color: '#F0E400', fillColor: '#F0E400', fillOpacity: 0.08, radius: 2000, weight: 2, dashArray: '5, 10'
                    }).addTo(map);
                    stationCircles.push(circle);
                }
            });

            if (watchedStations.value.length === 1) {
                 const s = watchedStations.value[0];
                 if(s.location) map.setView([s.location.latitude, s.location.longitude], 14);
            } else {
                 map.fitBounds(bounds, { padding: [50, 50] });
            }

            if (radarInterval) clearTimeout(radarInterval);
            
            for (let id in vehicleMarkers) { map.removeLayer(vehicleMarkers[id]); }
            for (let id in vehicleTrails) { map.removeLayer(vehicleTrails[id]); }
            if (routeLayer) routeLayer.clearLayers();
            vehicleMarkers = {};
            vehicleTrails = {};
            vehiclePreviousPositions = {};
            lastRadarData.value = [];
            isRadarActive.value = false;
        };
        
        const focusVehicle = (tripId) => {
             if (!map) return;
             const marker = vehicleMarkers[tripId];
             if (marker) {
                 map.setView(marker.getLatLng(), 16);
                 marker.openPopup();
             }
        };

        const toggleTrip = async (dep) => {
          if (expandedTripId.value === dep.tripId) { 
              expandedTripId.value = null; 
              if (routeLayer) routeLayer.clearLayers(); // Clear route on collapse
              return; 
          }
          
          // Always clear previous route when switching
          if (routeLayer) routeLayer.clearLayers();

          expandedTripId.value = dep.tripId;
          
          // Map interaction: skipped on mobile (<768px)
          const isMobile = window.innerWidth < 768;
          
          if(showMap.value && !isMobile) {
             let p = dep.line.product;
             if(p === 'nationalExpress' || p === 'national') p = 'express';
             if(p === 'regionalExp') p = 'regional';
             const color = productColors[p] || productColors.default;
             
             // Check if vehicle is on map
             const hasVehicle = vehicleMarkers[dep.tripId];
             
             if (hasVehicle) {
                 focusVehicle(dep.tripId);
                 // If we focus on vehicle, we don't need to fit route
                 showVehicleRoute(dep.tripId, color, false); 
             } else {
                 // UPDATED: If vehicle is missing, we show route BUT do NOT auto-zoom (false)
                 // This keeps focus on the station as requested.
                 showVehicleRoute(dep.tripId, color, false); 
             }
          }

          if (dep.cancelled) return;

          stopoverLimit.value = 5;
          isTripLoading.value = true;
          try {
            const res = await axios.get(`${apiBase.value}/trips/${encodeURIComponent(dep.tripId)}`, { params: { stopovers: true } });
            const allStops = res.data.trip.stopovers || [];
            // Keep full stopover list (we will slice based on vehicle progress in computed)
            currentTripStopovers.value = allStops.filter(stop => stop && stop.stop && stop.stop.id);

          } catch (e) { console.error(e); } finally { isTripLoading.value = false; }
        };

        // --- New Feature: Show Vehicle Route on Map ---
        const showVehicleRoute = async (tripId, color, fitToPolyline = false) => {
            if (!routeLayer) return;
            routeLayer.clearLayers();
            
            try {
                // Fetch trip details with polyline
                const res = await axios.get(`${apiBase.value}/trips/${encodeURIComponent(tripId)}`, {
                    params: { polyline: true, stopovers: true }
                });

                const trip = res.data.trip;

                // 1. Force Extract Polyline Coordinates (FORCE CONNECTION)
                let lineCoords = [];

                if (trip.polyline) {
                    // Use Leaflet's GeoJSON utility to parse, then extract coords
                    L.geoJSON(trip.polyline, {
                        onEachFeature: function (feature, layer) {
                            if (feature.geometry.type === 'LineString') {
                                if (layer.getLatLngs) {
                                    const latlngs = layer.getLatLngs();
                                    latlngs.forEach(ll => lineCoords.push(ll));
                                }
                            } else if (feature.geometry.type === 'Point') {
                                if (layer.getLatLng) {
                                    lineCoords.push(layer.getLatLng());
                                }
                            }
                        }
                    });
                }
                
                // If GeoJSON didn't give us a line (e.g. malformed or missing), fallback to stops
                if (lineCoords.length < 2 && trip.stopovers) {
                     lineCoords = trip.stopovers
                        .filter(s => s.stop && s.stop.location)
                        .map(s => L.latLng(s.stop.location.latitude, s.stop.location.longitude));
                }

                // DRAW THE LINE (On Lower Pane)
                if (lineCoords.length > 1) {
                    const poly = L.polyline(lineCoords, { 
                        color: color, 
                        opacity: 0.8, 
                        weight: 5, 
                        lineCap: 'round',
                        lineJoin: 'round',
                        className: 'no-transition',
                        pane: 'customRouteLinePane' // <--- LOWER Z-INDEX
                    }).addTo(routeLayer);
                    
                    // NEW: Fit bounds if requested (e.g. vehicle not visible)
                    if (fitToPolyline && map) {
                        map.fitBounds(poly.getBounds(), { padding: [40, 40] });
                    }
                }

                // 2. Draw Stops (On Higher Pane)
                if (trip.stopovers) {
                    trip.stopovers.forEach(stop => {
                        if (!stop.stop || !stop.stop.location) return;
                        const lat = stop.stop.location.latitude;
                        const lon = stop.stop.location.longitude;

                        L.circleMarker([lat, lon], {
                            radius: 4,
                            color: color,
                            fillColor: isDarkMode.value ? '#222' : '#fff', 
                            fillOpacity: 1,
                            weight: 2,
                            className: 'no-transition',
                            pane: 'customRouteStopsPane' // <--- HIGHER Z-INDEX
                        }).bindTooltip(escapeHtml(cleanName(stop.stop.name)), { 
                            permanent: true, 
                            direction: 'auto', 
                            className: 'route-stop-label',
                            offset: [5, 0],
                            pane: 'customRouteStopsPane' // Ensure label is also on top
                        }).addTo(routeLayer);
                    });
                }

            } catch(e) {
                console.warn("Failed to load vehicle route", e);
            }
        };

        const getStopPlannedTime = (stop) => {
          return stop.plannedArrival || stop.plannedDeparture || stop.arrival || stop.departure || null;
        };

        const getStopDelaySec = (stop) => {
          if (typeof stop.arrivalDelay === 'number') return stop.arrivalDelay;
          if (typeof stop.departureDelay === 'number') return stop.departureDelay;

          const planned = stop.plannedArrival || stop.plannedDeparture;
          const realtime = stop.arrival || stop.departure;
          if (planned && realtime) {
            return Math.round((new Date(realtime) - new Date(planned)) / 1000);
          }
          return 0;
        };

        const formatPlannedWithDelay = (stop) => {
          const planned = getStopPlannedTime(stop);
          if (!planned) return '';
          const abs = formatAbsTime(planned);
          const d = getStopDelaySec(stop);
          if (!d) return abs;
          const min = Math.round(d / 60);
          const sign = min > 0 ? '+' : '';
          return `${abs} ${sign}${min}`;
        };

        const isWatchedStop = (stopId) => {
          return !!(
            (station1.value && station1.value.id === stopId) ||
            (station2.value && station2.value.id === stopId)
          );
        };

        const stopoverDisplayStops = computed(() => {
          const list = currentTripStopovers.value || [];
          if (list.length === 0) return [];

          // find last passed stop (by realtime or planned)
          const nowTs = now.value.getTime();
          let lastPassed = -1;
          for (let i = 0; i < list.length; i++) {
            const st = list[i];
            const t = st.departure || st.arrival || st.plannedDeparture || st.plannedArrival;
            if (!t) continue;
            if (new Date(t).getTime() <= nowTs) lastPassed = i;
          }

          const startIdx = Math.max(0, lastPassed);
          const sliced = list.slice(startIdx);

          // Blink the next stop node (vehicle is heading towards it)
          const blinkIdx = Math.min(1, Math.max(0, sliced.length - 1));

          return sliced.slice(0, stopoverLimit.value).map((s, idx) => ({
            stop: s,
            idx,
            isBlink: idx === blinkIdx,
            isWatched: isWatchedStop(s.stop.id),
            isFuture: idx > 0,
          }));
        });

        
        // ==============================
        // Data fetch: Departures + Radar
        // ==============================

        const departuresError = ref(false);

        const departureCacheKey = () => {
          const stationIds = watchedStations.value.map(station => station.id).filter(Boolean).join('_');
          return `bvg_departures_cache_${stationIds}_${duration.value}`;
        };

        const classifyFetchError = (error) => {
          const status = error && error.response && error.response.status;
          if (status === 429) return 'rateLimited';
          if (status === 404 || status === 400) return 'invalidStation';
          if (status >= 500 || error.code === 'ERR_NETWORK' || error.message === 'Network Error') return 'upstreamError';
          return 'noSignal';
        };

        const setDeparturesFromCache = () => {
          try {
            const cached = localStorage.getItem(departureCacheKey());
            if (!cached) return false;
            const parsed = JSON.parse(cached);
            if (!parsed || !Array.isArray(parsed.departures)) return false;
            departuresRaw.value = parsed.departures;
            departuresLastUpdated.value = parsed.fetchedAt ? new Date(parsed.fetchedAt) : null;
            departuresIsStale.value = true;
            return true;
          } catch (e) {
            console.warn('Failed to read cached departures', e);
            return false;
          }
        };

        const saveDeparturesCache = (items, fetchedAt) => {
          try {
            localStorage.setItem(departureCacheKey(), JSON.stringify({
              fetchedAt: fetchedAt.toISOString(),
              departures: items,
            }));
          } catch (e) {
            console.warn('Failed to save cached departures', e);
          }
        };

        const departureStatusText = computed(() => {
          if (!departuresLastUpdated.value) return '';
          const time = departuresLastUpdated.value.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
          return (departuresIsStale.value ? t.value.staleData : t.value.liveData).replace('{t}', time);
        });

        const departureErrorText = computed(() => {
          if (!departuresError.value) return '';
          return t.value[departuresErrorType.value] || t.value.noSignal;
        });

        const shouldFetchPoststadionPredictions = () => {
          return watchedStations.value.some(station => String(station && station.id) === POSTSTADION_STOP_ID);
        };

        const fetchPoststadionPredictions = async () => {
          if (!shouldFetchPoststadionPredictions()) return {};
          try {
            const res = await axios.get(`${apiBase.value}/predictions/poststadion`, {
              params: { duration: duration.value }
            });
            return (res.data && res.data.predictions) || {};
          } catch (e) {
            console.warn('Poststadion prediction unavailable', e);
            return {};
          }
        };

        const fetchDepartures = async (silent = false) => {
          if (watchedStations.value.length === 0) {
              departuresRaw.value = [];
              departuresLastUpdated.value = null;
              departuresIsStale.value = false;
              departuresError.value = false;
              currentDeparturesCacheKey = '';
              return;
          }

          const cacheKey = departureCacheKey();
          const stationSetChanged = cacheKey !== currentDeparturesCacheKey;

          if (!silent) {
              loading.value = true;
              departuresError.value = false;
              departuresErrorType.value = null;
              if (stationSetChanged) {
                departuresRaw.value = [];
                departuresLastUpdated.value = null;
                departuresIsStale.value = false;
              }
              if (departuresRaw.value.length === 0) setDeparturesFromCache();
          }

          try {
            const responses = await Promise.all(watchedStations.value.map(station => 
                axios.get(`${apiBase.value}/stops/${station.id}/departures`, { 
                    params: { duration: duration.value, results: 50 } 
                })
            ));

            const results = responses.map((res, idx) => {
              const station = watchedStations.value[idx];
              const deps = res.data.departures || [];
              return deps.map(d => ({...d, stationName: station.name, stationId: String(station.id), uniqueId: d.tripId + '_' + station.id}));
            });
            let allDeps = results.flat();
            if (shouldFetchPoststadionPredictions()) {
              const predictions = await fetchPoststadionPredictions();
              allDeps = allDeps.map(dep => {
                if (
                  String(dep.stationId) === POSTSTADION_STOP_ID &&
                  dep.line &&
                  POSTSTADION_PREDICTION_LINES.has(dep.line.name) &&
                  predictions[dep.uniqueId]
                ) {
                  return { ...dep, prediction: predictions[dep.uniqueId] };
                }
                return dep;
              });
            }
            const staleFromProxy = responses.some(res => String(res.headers['x-proxy-cache'] || '').toUpperCase() === 'STALE');
            const fetchedHeader = responses.map(res => res.headers['x-proxy-fetched-at']).filter(Boolean).sort()[0];
            const fetchedAt = fetchedHeader ? new Date(fetchedHeader) : new Date();
            departuresRaw.value = allDeps;
            departuresLastUpdated.value = isNaN(fetchedAt.getTime()) ? new Date() : fetchedAt;
            departuresIsStale.value = staleFromProxy;
            departuresError.value = false;
            departuresErrorType.value = null;
            departuresFailureCount = 0;
            currentDeparturesCacheKey = cacheKey;
            saveDeparturesCache(allDeps, departuresLastUpdated.value);
            startRadarLoop();
          } catch (e) { 
              console.error(e);
              departuresFailureCount += 1;
              departuresError.value = true;
              departuresErrorType.value = classifyFetchError(e);
              currentDeparturesCacheKey = cacheKey;
              if (departuresRaw.value.length === 0) setDeparturesFromCache();
          } finally { 
              if (!silent) loading.value = false; 
          }
        };

        const ui = createUiHandlers({
          computed,
          nextTick,
          windowObj: window,
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
          mapGet: () => map,
        });

        const pullOpacity = ui.pullOpacity;
        const pullTranslate = ui.pullTranslate;
        const toggleInfoState = ui.toggleInfoState;
        const onDragStart = ui.onDragStart;
        const onDragMove = ui.onDragMove;
        const onDragEnd = ui.onDragEnd;
        const onPullStart = ui.onPullStart;
        const onPullMove = ui.onPullMove;
        const onPullEnd = ui.onPullEnd;
        const zoomIn = ui.zoomIn;
        const zoomOut = ui.zoomOut;

        const toggleMap = () => ui.toggleMap(showMap);


        // Stations: search + favorites (wired after dependencies exist)
        const stations = createStationHandlers({
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
          setUserLocation: ({ latitude, longitude }) => {
            try {
              if (!map) return;

              if (!window.__userLocationMarker) {
                const icon = L.divIcon({
                  className: 'user-location-marker',
                  html: '<div style="width:12px;height:12px;border-radius:50%;background:#3b82f6;border:2px solid white;box-shadow:0 0 0 2px rgba(59,130,246,0.25);"></div>',
                  iconSize: [12, 12],
                  iconAnchor: [6, 6],
                });
                window.__userLocationMarker = L.marker([latitude, longitude], { icon }).addTo(map);
              } else {
                window.__userLocationMarker.setLatLng([latitude, longitude]);
              }
            } catch (e) {
              console.warn('Failed to set user location on map', e);
            }
          },
        });

        const isStarred = stations.isStarred;
        const toggleStar = stations.toggleStar;
        const showFavorites = stations.showFavorites;

        const onMainFocus = stations.onMainFocus;
        const onMainBlur = stations.onMainBlur;

        const isMainDropdownVisible = stations.isMainDropdownVisible;
        const displaySearchResults = stations.displaySearchResults;
        const displayFavoriteResults = stations.displayFavoriteResults;
        const displayNearbyResults = stations.displayNearbyResults;

        const onMainInput = stations.onMainInput;
        const onS1Input = stations.onS1Input;
        const onS2Input = stations.onS2Input;

        const nearbyStations = stations.nearbyStations;
        const isGeoEnabled = stations.isGeoEnabled;
        const refreshNearby = stations.refreshNearby;

        const selectStation = stations.selectStation;
        const setStation = stations.setStation;
        const clearStation = stations.clearStation;
        const resetStations = stations.resetStations;


        const fetchRadar = async () => {
            if (watchedStations.value.length === 0) return;

            if (radarAbortController) { radarAbortController.abort(); }
            radarAbortController = new AbortController();
            const signal = radarAbortController.signal;

            const fetchPromises = watchedStations.value.map(station => {
                if (!station.location) return Promise.resolve([]);
                const { latitude, longitude } = station.location;
                const bbox = getBoundingBox(latitude, longitude, 2.0); 
                return axios.get(`${apiBase.value}/radar`, {
                    params: {
                        north: bbox.north, west: bbox.west, south: bbox.south, east: bbox.east,
                        results: 256, duration: 60, frames: 3, polylines: true 
                    },
                    signal: signal
                }).then(res => {
                    return Array.isArray(res.data) ? res.data : (res.data.movements || []);
                }).catch(e => {
                    if (axios.isCancel(e)) throw e;
                    console.warn(`Radar fetch failed for ${station.name}`, e);
                    return []; 
                });
            });

            try {
                const results = await Promise.all(fetchPromises);
                const vehicleMap = new Map();
                results.flat().forEach(v => {
                    if (v && v.tripId) {
                        vehicleMap.set(v.tripId, v); 
                    }
                });
                const combinedVehicles = Array.from(vehicleMap.values());
                isRadarActive.value = true;
                radarError.value = false;
                radarFailureCount = 0;
                lastRadarData.value = combinedVehicles;
                if (showMap.value) updateVehicleMarkers(combinedVehicles);
            } catch (e) {
                if (axios.isCancel(e)) return;
                radarFailureCount += 1;
                radarError.value = true;
                console.warn("Radar update skipped/failed"); 
            }
        };

        const isValidPosition = (point) => {
            return point && typeof point.latitude === 'number' && typeof point.longitude === 'number';
        };

        const getLocationPoint = (value) => {
            if (!value) return null;
            if (isValidPosition(value)) return value;
            if (isValidPosition(value.location)) return value.location;
            return null;
        };

        const calculateBearing = (from, to) => {
            if (!isValidPosition(from) || !isValidPosition(to)) return null;

            const lat1 = from.latitude * Math.PI / 180;
            const lat2 = to.latitude * Math.PI / 180;
            const deltaLon = (to.longitude - from.longitude) * Math.PI / 180;
            const y = Math.sin(deltaLon) * Math.cos(lat2);
            const x = Math.cos(lat1) * Math.sin(lat2) -
                Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);

            return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
        };

        const getVehicleBearing = (tripId, currentPosition, frames) => {
            if (Array.isArray(frames)) {
                const validFrames = frames.filter(isValidPosition);
                for (let i = validFrames.length - 1; i > 0; i--) {
                    const from = validFrames[i - 1];
                    const to = validFrames[i];
                    if (L.latLng(from.latitude, from.longitude).distanceTo([to.latitude, to.longitude]) > 1) {
                        return calculateBearing(from, to);
                    }
                }

                const currentFrame = frames.find(frame => Number(frame && frame.t) === 0) || frames[0];
                const frameOrigin = getLocationPoint(currentFrame && currentFrame.origin);
                const frameDestination = getLocationPoint(currentFrame && currentFrame.destination);
                if (
                    frameOrigin &&
                    frameDestination &&
                    L.latLng(frameOrigin.latitude, frameOrigin.longitude).distanceTo([frameDestination.latitude, frameDestination.longitude]) > 1
                ) {
                    return calculateBearing(frameOrigin, frameDestination);
                }
            }

            const previousPosition = vehiclePreviousPositions[tripId];
            if (
                previousPosition &&
                isValidPosition(currentPosition) &&
                L.latLng(previousPosition.latitude, previousPosition.longitude).distanceTo([currentPosition.latitude, currentPosition.longitude]) > 1
            ) {
                return calculateBearing(previousPosition, currentPosition);
            }

            return null;
        };

        const updateVehicleMarkers = (vehicles) => {
            if (!map) return;
            const activeIds = new Set();
            const validTripIds = new Set(departures.value.map(d => d.tripId));
            
            const mapProduct = (p) => {
                if(p === 'nationalExpress' || p === 'national') return 'express';
                if(p === 'regionalExp') return 'regional';
                return p;
            };

            const isMapRelevant = (prod) => ['bus', 'tram', 'suburban', 'subway', 'regional', 'ferry', 'regionalExp'].includes(prod);

            vehicles.forEach(v => {
                if (!v.location || !v.line) return;
                if (!validTripIds.has(v.tripId)) return; 
                
                // FIX 2: Filter out express from map
                let p = v.line.product;
                if (p === 'express' || p === 'national' || p === 'nationalExpress') return;

                if (!isMapRelevant(p)) return;

                const tripId = v.tripId;
                activeIds.add(tripId);
                const prod = mapProduct(v.line.product) || 'default';
                const productClass = `marker-${prod}`;
                const label = v.line.name || '?';
                const color = productColors[prod] || productColors.default;
                const bearing = getVehicleBearing(tripId, v.location, v.frames);
                
                let polylinePoints = [];
                if (v.frames && Array.isArray(v.frames)) {
                    const validFrames = v.frames.filter(f => f && typeof f.latitude === 'number' && typeof f.longitude === 'number');
                    polylinePoints = validFrames.map(f => [f.latitude, f.longitude]);
                }

                if (vehicleTrails[tripId]) { map.removeLayer(vehicleTrails[tripId]); }
                if (polylinePoints.length > 1) {
                    vehicleTrails[tripId] = L.polyline(polylinePoints, {
                        color: color, weight: 3, opacity: 0.6, dashArray: '3, 6'
                    }).addTo(map);
                }

                const badgeStyle = `background-color: ${color}; color: white; padding: 2px 6px; border-radius: 4px; display: inline-block; line-height: 1.2; font-weight: 800;`;
                const popupContent = `<div style="display: flex; align-items: center; gap: 8px;"><span class="vehicle-popup-badge" style="${badgeStyle}">${escapeHtml(v.line.name)}</span> <span>${escapeHtml(cleanName(v.direction))}</span></div>`;

                const arrowHtml = bearing === null ? '' : `<div class="vehicle-direction-arrow" style="transform: translate(-50%, -50%) rotate(${bearing.toFixed(1)}deg);"></div>`;
                const html = `<div class="vehicle-marker-wrapper">${arrowHtml}<div class="vehicle-marker ${productClass}">${escapeHtml(label)}</div></div>`;
                const icon = L.divIcon({ className: 'smooth-transition', html: html, iconSize: [32, 32], iconAnchor: [16, 16], popupAnchor: [0, -16] });
                vehiclePreviousPositions[tripId] = {
                    latitude: v.location.latitude,
                    longitude: v.location.longitude
                };

                if (vehicleMarkers[tripId]) {
                    const marker = vehicleMarkers[tripId];
                    const newLatLng = L.latLng(v.location.latitude, v.location.longitude);
                    if (marker.getLatLng().distanceTo(newLatLng) > 1) { marker.setLatLng(newLatLng); }
                    marker.setPopupContent(popupContent);
                    marker.setIcon(icon);
                    // Update click listener just in case
                    marker.off('click').on('click', (e) => {
                        L.DomEvent.stopPropagation(e); // Stop propagation so map click doesn't clear route
                        showVehicleRoute(tripId, color);
                        marker.openPopup(); // Force popup open
                    });
                } else {
                    const marker = L.marker([v.location.latitude, v.location.longitude], { icon: icon })
                     .addTo(map)
                     .bindPopup(popupContent, { className: 'vehicle-popup', offset: [0, -2], closeButton: false });
                    
                    // BIND CLICK EVENT FOR ROUTE
                    marker.on('click', (e) => {
                        L.DomEvent.stopPropagation(e); // Stop propagation
                        showVehicleRoute(tripId, color);
                        marker.openPopup(); // Force popup open
                    });

                    vehicleMarkers[tripId] = marker;
                }
            });

            for (let id in vehicleMarkers) {
                if (!activeIds.has(id)) {
                    map.removeLayer(vehicleMarkers[id]); delete vehicleMarkers[id];
                    if (vehicleTrails[id]) { map.removeLayer(vehicleTrails[id]); delete vehicleTrails[id]; }
                    delete vehiclePreviousPositions[id];
                }
            }
        };

        const startRadarLoop = () => {
            if (radarInterval) clearTimeout(radarInterval);
            fetchRadar().finally(() => {
                const delay = radarFailureCount >= 3 ? 120000 : (radarFailureCount >= 1 ? 60000 : 30000);
                radarInterval = setTimeout(startRadarLoop, delay);
            });
        };

        const isTerminalFilterActive = ref(false);

        // Terminal filter can be enabled at any time from settings.
        const terminalFilterEnabled = computed(() => isTerminalFilterActive.value);

        const terminalsByLine = computed(() => {
          const tmp = {};
          departuresRaw.value.forEach(d => {
            if (!d.line || !d.line.name) return;

            let p = d.line.product;
            if (p === 'nationalExpress' || p === 'national') p = 'express';
            if (p === 'regionalExp') p = 'regional';
            if (!activeFilters.value.includes(p)) return;
            if (p === 'express') return;

            const lineName = d.line.name;
            const terminal = (d.direction || '').trim();
            if (!terminal) return;

            if (!tmp[lineName]) tmp[lineName] = new Set();
            tmp[lineName].add(terminal);
          });

          const out = {};
          Object.keys(tmp).forEach(k => {
            out[k] = Array.from(tmp[k]).sort();
          });
          return out;
        });

        const isTerminalExcluded = (lineName, terminal) => {
          return !!(terminalExclusions.value[lineName] && terminalExclusions.value[lineName][terminal]);
        };

        const toggleTerminalExclusion = (lineName, terminal) => {
          const next = { ...terminalExclusions.value };
          const curLine = { ...(next[lineName] || {}) };

          if (curLine[terminal]) delete curLine[terminal];
          else curLine[terminal] = true;

          if (Object.keys(curLine).length === 0) delete next[lineName];
          else next[lineName] = curLine;

          terminalExclusions.value = next;
        };

        const departures = computed(() => {
          return departuresRaw.value
            .filter(d => {
              let p = d.line.product;
              if (p === 'nationalExpress' || p === 'national') p = 'express';
              if (p === 'regionalExp') p = 'regional';
              
              return activeFilters.value.includes(p);
            })
            .filter(d => {
                if (excludedLines.value.has(d.line.name)) return false;
                return true;
            })
            .filter(d => {
                if (!terminalFilterEnabled.value) return true;
                const lineName = d.line && d.line.name;
                const terminal = (d.direction || '').trim();
                if (!lineName || !terminal) return true;
                return !isTerminalExcluded(lineName, terminal);
            })
            .filter(d => {
               const time = d.when || d.plannedWhen;
               return (new Date(time) - now.value) >= -30000;
            })
            .sort((a, b) => new Date(a.when || a.plannedWhen) - new Date(b.when || b.plannedWhen));
        });

        watch(departures, (newDeps) => {
            if (!map) return;
            const currentTripIds = new Set(newDeps.map(d => d.tripId));
            for (let id in vehicleMarkers) {
                if (!currentTripIds.has(id)) {
                    map.removeLayer(vehicleMarkers[id]); delete vehicleMarkers[id];
                    if (vehicleTrails[id]) { map.removeLayer(vehicleTrails[id]); delete vehicleTrails[id]; }
                    delete vehiclePreviousPositions[id];
                }
            }
            if (lastRadarData.value.length > 0 && showMap.value) { updateVehicleMarkers(lastRadarData.value); }
        }, { deep: true });

        const uniqueLinesList = computed(() => {
            const lines = new Set();
            departuresRaw.value.forEach(d => {
                if (d.line && d.line.name) {
                    let p = d.line.product;
                    if (p === 'nationalExpress' || p === 'national') p = 'express';
                    if (p === 'regionalExp') p = 'regional';
                    
                    if (!activeFilters.value.includes(p)) return;
                    if (p === 'express') return;
                    lines.add(d.line.name);
                }
            });
            excludedLines.value.forEach(l => lines.add(l));
            return Array.from(lines).sort();
        });

        const filteredLineList = computed(() => {
            return uniqueLinesList.value;
        });

        const toggleLineExclusion = (lineName) => {
            if (excludedLines.value.has(lineName)) {
                excludedLines.value.delete(lineName);
            } else {
                excludedLines.value.add(lineName);
            }
        };

        const hasLineFilterChanges = computed(() => {
          return (
            excludedLines.value.size > 0 ||
            Object.keys(terminalExclusions.value || {}).length > 0 ||
            isTerminalFilterActive.value
          );
        });

        const resetLineFilters = () => {
            excludedLines.value.clear();
            terminalExclusions.value = {};
            isTerminalFilterActive.value = false;
        };

        const isDeparted = (dep) => (new Date(dep.when || dep.plannedWhen) - now.value) <= 0;

        // UPDATED: Delay Logic
        const getDelayClass = (d) => {
            if (d.cancelled) return "status-cancel";
            if (d.delay === null) return "status-static";
            
            const delaySec = d.delay;
            const p = d.line.product;
            const isFern = ['express', 'national', 'nationalExpress'].includes(p);
            
            // Fern: > 15 min (900s) RED, > 0 ORANGE
            if (isFern) {
                if (delaySec >= 900) return "status-red";
                if (delaySec > 0) return "status-orange";
            } else {
                // Others: > 5 min (300s) RED, > 0 ORANGE
                if (delaySec >= 300) return "status-red";
                if (delaySec > 0) return "status-orange";
            }
            return "status-green"; // On time or early
        };

        const shouldShowPrediction = (dep) => {
          const predicted = getPredictionArrivalDate(dep);
          const displayed = dep ? new Date(dep.when || dep.plannedWhen) : null;
          return !!(
            dep &&
            dep.prediction &&
            String(dep.stationId) === POSTSTADION_STOP_ID &&
            dep.line &&
            POSTSTADION_PREDICTION_LINES.has(dep.line.name) &&
            predicted &&
            displayed &&
            !Number.isNaN(displayed.getTime()) &&
            Math.abs(predicted - displayed) >= 120000
          );
        };

        const getPredictionClass = (prediction) => {
          if (!prediction || typeof prediction.predictedDelayMin !== 'number') return 'prediction-neutral';
          if (prediction.predictedDelayMin >= 5) return 'prediction-red';
          if (prediction.predictedDelayMin > 0) return 'prediction-orange';
          return 'prediction-green';
        };

        const getPredictionArrivalDate = (dep) => {
          if (!dep || !dep.prediction || typeof dep.prediction.predictedDelayMin !== 'number') return null;
          const planned = new Date(dep.plannedWhen || dep.when);
          if (Number.isNaN(planned.getTime())) return null;
          return new Date(planned.getTime() + dep.prediction.predictedDelayMin * 60000);
        };

        const formatPredictionTime = (dep) => {
          const predicted = getPredictionArrivalDate(dep);
          return predicted ? formatAbsTime(predicted.toISOString()) : '';
        };

        const formatTime = (iso) => {
          const diff = (new Date(iso) - now.value) / 60000;
          if (diff <= 0) return "";
          if (diff <= 0.34) return t.value.now; // 0-20 seconds (approx 0.333)
          return t.value.inMin.replace('{t}', Math.ceil(diff));
        };
        const formatAbsTime = (iso) => iso ? new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : "";
        const isTypeActive = (t) => activeFilters.value.includes(t);
        const toggleType = (t) => {
          if (activeFilters.value.includes(t)) activeFilters.value = activeFilters.value.filter(x => x !== t);
          else activeFilters.value.push(t);
        };
        
        const getProductClass = (p) => {
             if (p === 'nationalExpress' || p === 'national') return 'product-express';
             if (p === 'regionalExp') return 'product-regional';
             return `product-${p}`;
        };

        // Helper for platform logic (S, U, RE, Fern)
        const isRail = (p) => ['suburban', 'subway', 'regional', 'regionalExp', 'express', 'national', 'nationalExpress'].includes(p);
        
        const clearSearch = () => {
          clearStation(1);
          clearStation(2);
          if (radarInterval) clearTimeout(radarInterval);
          if (map) {
              for (let id in vehicleMarkers) { map.removeLayer(vehicleMarkers[id]); }
              for (let id in vehicleTrails) { map.removeLayer(vehicleTrails[id]); }
              if (routeLayer) routeLayer.clearLayers();
              vehicleMarkers = {};
              vehicleTrails = {};
              vehiclePreviousPositions = {};
              lastRadarData.value = [];
              stationMarkers.forEach(m => map.removeLayer(m));
              stationMarkers = [];
              stationCircles.forEach(c => map.removeLayer(c));
              stationCircles = [];
          }
          isRadarActive.value = false;
        };

        return {
          currentTime, mainSearchQuery, searchQuery, searchResults, departures, loading, duration, 
          isTypeActive, toggleType, selectStation, onMainInput, clearSearch,
          formatTime, formatAbsTime, getDelayClass, isDeparted, getProductClass,
          shouldShowPrediction, getPredictionClass, formatPredictionTime,
          onDurationChange: () => fetchDepartures(), expandedTripId, toggleTrip, isTripLoading,
          currentTripStopovers, stopoverDisplayStops, stopoverLimit, formatPlannedWithDelay, isWatchedStop,
          starredStations, isStarred, toggleStar,
          isShowingFavorites, showFavorites,
          isMainDropdownVisible, displaySearchResults, displayFavoriteResults, displayNearbyResults,
          onMainFocus, onMainBlur,
          nearbyStations, isGeoEnabled, refreshNearby,
          dashboardStopsTab,
          isRadarActive, radarError, cleanName,
          isDarkMode, zoomIn, zoomOut,
          infoState, toggleInfoState, infoStateClass, sidebarMobileClass, toggleIcon,
          showSettings, setStation, clearStation, watchedStations,
          filteredLineList, toggleLineExclusion, excludedLines, resetLineFilters, hasLineFilterChanges,
          isTerminalFilterActive, terminalFilterEnabled, terminalsByLine, isTerminalExcluded, toggleTerminalExclusion,
          station1, station2, s1Query, s2Query, s1Results, s2Results, onS1Input, onS2Input,
          showMap, toggleMap, resetStations,
          t, currentLang, toggleLang,
          isLedMode, 
          currentTheme, setTheme, 
          networkError, departuresError, departuresErrorType, departureStatusText, departureErrorText, departuresIsStale,
          isTimebarHidden, toggleTimebar,
          isLargeFont, toggleFontSize,
          sidebarRef,
          isDragging, onDragStart, onDragMove, onDragEnd,
          currentApiName,
          isRail,
          // Pull To Refresh
          infoSectionRef, onPullStart, onPullMove, onPullEnd, pullOpacity, pullTranslate, isRefreshing
        };
      }
    }).mount("#app");
