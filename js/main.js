import { translations, API_ENDPOINTS, PRODUCT_COLORS, DARK_TILES, LIGHT_TILES } from './constants.js';
import { cleanName, getBoundingBox } from './utils.js';
import { createUiHandlers } from './ui.js';

// --- iOS 12 / iPhone 6 Polyfill Check ---
    if (typeof ResizeObserver === 'undefined') {
        window.ResizeObserver = class ResizeObserver {
            observe() {}
            unobserve() {}
            disconnect() {}
        };
    }

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

        const loading = ref(false);
        const activeFilters = ref(['suburban', 'subway', 'tram', 'bus', 'regional', 'express']);
        const duration = ref(30);
        
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
        let radarInterval; 
        
        let autoRefreshTimer = null; 
        
        let searchTimeout;
        const searchAbortController = ref(null);
        let radarAbortController = null;

        const productColors = PRODUCT_COLORS;

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

        const toggleIcon = computed(() => {
            if (infoState.value === 2) return 'fa-angles-up'; 
            return 'fa-chevron-down'; 
        });

        
        // ==============================
        // UI: Drag + Pull-to-refresh
        // ==============================
        // --- Pull To Refresh Logic ---

        watch(isDarkMode, (newVal) => {
          if (newVal) {
             document.body.classList.remove('light-mode');
             if (baseLayer) baseLayer.setUrl(DARK_TILES);
          } else {
             document.body.classList.add('light-mode');
             if (baseLayer) baseLayer.setUrl(LIGHT_TILES);
          }
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
          
          baseLayer = L.tileLayer(isDarkMode.value ? DARK_TILES : LIGHT_TILES, {
            attribution: '&copy; OpenStreetMap &copy; CARTO'
          }).addTo(map);

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

          setInterval(() => { now.value = new Date(); currentTime.value = now.value.toLocaleTimeString("de-DE"); }, 1000);
          
          autoRefreshTimer = setInterval(() => {
              if (watchedStations.value.length > 0) {
                  fetchDepartures(true);
              }
          }, 30000);

          const saved = localStorage.getItem('bvg_fav_stations');
          if (saved) { starredStations.value = JSON.parse(saved); }
        });

        onUnmounted(() => {
          if (radarInterval) clearInterval(radarInterval);
          if (autoRefreshTimer) clearInterval(autoRefreshTimer);
        });

        const isStarred = (id) => starredStations.value.some(s => s.id === id);
        const toggleStar = (station) => {
          if (isStarred(station.id)) {
            starredStations.value = starredStations.value.filter(s => s.id !== station.id);
          } else {
            starredStations.value.push({
              id: station.id,
              name: station.name,
              location: station.location, 
              type: station.type
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
          if (mainSearchQuery.value && s1Results.value.length > 0) { return s1Results.value; } 
          else if (!mainSearchQuery.value && starredStations.value.length > 0) { return starredStations.value; }
          return [];
        });

        watch(mainSearchQuery, (newVal) => {
          if (!newVal) { isShowingFavorites.value = true; } 
          else { isShowingFavorites.value = false; }
        });

        const onSearchInput = () => {
        };
        
        // Handling the Main Search Input (Outer)
        const onMainInput = () => {
            // When user types in main, we assume they are searching for a new station (Slot 1)
            // This syncs the input to s1Query to trigger the existing search logic
            s1Query.value = mainSearchQuery.value;
            handleSearch(s1Query, s1Results, s1AbortController);
        };

        // Handling the Settings Search Input (Inner)
        const onS1Input = () => {
            handleSearch(s1Query, s1Results, s1AbortController);
        };
        const onS2Input = () => {
            handleSearch(s2Query, s2Results, s2AbortController);
        };

        
        // ==============================
        // Search (stations)
        // ==============================

        const handleSearch = (queryRef, resultsRef, abortRef) => {
          if (searchTimeout) clearTimeout(searchTimeout);
          if (abortRef.value) { abortRef.value.abort(); }

          searchTimeout = setTimeout(async () => {
            if (!queryRef.value) {
              resultsRef.value = [];
              return;
            }

            // Prevent searching for combined station names
            if (queryRef.value.includes(" + ")) {
                return;
            }

            const controller = new AbortController();
            abortRef.value = controller;

            try {
              const res = await axios.get(`${apiBase.value}/locations`, { 
                params: { query: queryRef.value, results: 6, stops: true },
                signal: controller.signal 
              });
              resultsRef.value = res.data.filter(s => s.type === 'stop');
            } catch (e) {
              if (axios.isCancel(e)) return; 
              console.error(e);
            }
          }, 300);
        };

        const selectStation = (station) => {
          // When selecting from main search, we assume single station mode or resetting slot 1
          station1.value = station;
          station2.value = null; // Clear second station
          s1Results.value = [];
          // infoState.value = 1; // Removed this to respect user preference/default 2
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
                s2Query.value = "";
                s2Results.value = [];
            }
            updateMapForStations();
            fetchDepartures();
        };

        const resetStations = () => {
            station1.value = null;
            station2.value = null;
            mainSearchQuery.value = "";
            s1Query.value = "";
            s2Query.value = "";
            s1Results.value = [];
            s2Results.value = [];
            updateMapForStations();
            fetchDepartures();
        };

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
                        .bindTooltip(`<div><i class="fas fa-rss me-1 rss-icon"></i>${cleanName(station.name)}</div>`, {
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

            if (radarInterval) clearInterval(radarInterval);
            
            for (let id in vehicleMarkers) { map.removeLayer(vehicleMarkers[id]); }
            for (let id in vehicleTrails) { map.removeLayer(vehicleTrails[id]); }
            if (routeLayer) routeLayer.clearLayers();
            vehicleMarkers = {};
            vehicleTrails = {};
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
          expandedTripId.value = dep.tripId;
          
          if(showMap.value) {
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
            const allStops = res.data.trip.stopovers;
            const departureTime = new Date(dep.when || dep.plannedWhen);

            currentTripStopovers.value = allStops.filter(stop => {
               const sTime = stop.arrival || stop.plannedArrival || stop.departure || stop.plannedDeparture;
               if (!sTime) return false;
               return new Date(sTime) > departureTime;
            });
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
                        }).bindTooltip(cleanName(stop.stop.name), { 
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

        const visibleStopovers = computed(() => currentTripStopovers.value.slice(0, stopoverLimit.value));

        
        // ==============================
        // Data fetch: Departures + Radar
        // ==============================

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
            const promises = watchedStations.value.map(station => 
                axios.get(`${apiBase.value}/stops/${station.id}/departures`, { 
                    params: { duration: duration.value, results: 50 } 
                }).then(res => {
                    const deps = res.data.departures || [];
                    return deps.map(d => ({...d, stationName: station.name, uniqueId: d.tripId + '_' + station.id}));
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
                lastRadarData.value = combinedVehicles;
                if (showMap.value) updateVehicleMarkers(combinedVehicles);
            } catch (e) {
                if (axios.isCancel(e)) return;
                console.warn("Radar update skipped/failed"); 
            }
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
                const popupContent = `<div style="display: flex; align-items: center; gap: 8px;"><span class="vehicle-popup-badge" style="${badgeStyle}">${v.line.name}</span> <span>${cleanName(v.direction)}</span></div>`;

                if (vehicleMarkers[tripId]) {
                    const marker = vehicleMarkers[tripId];
                    const newLatLng = L.latLng(v.location.latitude, v.location.longitude);
                    if (marker.getLatLng().distanceTo(newLatLng) > 1) { marker.setLatLng(newLatLng); }
                    marker.setPopupContent(popupContent);
                    // Update click listener just in case
                    marker.off('click').on('click', (e) => {
                        L.DomEvent.stopPropagation(e); // Stop propagation so map click doesn't clear route
                        showVehicleRoute(tripId, color);
                        marker.openPopup(); // Force popup open
                    });
                } else {
                    const html = `<div class="vehicle-marker-wrapper"><div class="vehicle-marker ${productClass}">${label}</div></div>`;
                    const icon = L.divIcon({ className: 'smooth-transition', html: html, iconSize: [36, 36], iconAnchor: [18, 18], popupAnchor: [0, -18] });
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
                }
            }
        };

        const startRadarLoop = () => {
            if (radarInterval) clearInterval(radarInterval);
            fetchRadar(); 
            radarInterval = setInterval(fetchRadar, 8000); 
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

        const resetLineFilters = () => {
            excludedLines.value.clear();
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
          if (radarInterval) clearInterval(radarInterval);
          if (map) {
              for (let id in vehicleMarkers) { map.removeLayer(vehicleMarkers[id]); }
              for (let id in vehicleTrails) { map.removeLayer(vehicleTrails[id]); }
              if (routeLayer) routeLayer.clearLayers();
              vehicleMarkers = {};
              vehicleTrails = {};
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
          isTypeActive, toggleType, selectStation, onMainInput, onSearchInput, clearSearch,
          formatTime, formatAbsTime, getDelayClass, isDeparted, getProductClass,
          onDurationChange: () => fetchDepartures(), expandedTripId, toggleTrip, isTripLoading,
          currentTripStopovers, visibleStopovers, stopoverLimit,
          starredStations, isStarred, toggleStar, displayResults, isShowingFavorites, showFavorites, isRadarActive, radarError, cleanName,
          isDarkMode, zoomIn, zoomOut,
          infoState, toggleInfoState, infoStateClass, sidebarMobileClass, toggleIcon,
          showSettings, setStation, clearStation, watchedStations,
          filteredLineList, toggleLineExclusion, excludedLines, resetLineFilters,
          station1, station2, s1Query, s2Query, s1Results, s2Results, onS1Input, onS2Input,
          showMap, toggleMap, resetStations,
          t, currentLang, toggleLang,
          isLedMode, 
          currentTheme, setTheme, 
          networkError,
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
