// Shared constants extracted from main.js
// Keep values identical to preserve behavior.

export const translations = {
  de: {
    settings: "Einstellungen",
    displayLang: "Anzeige & Sprache",
    dark: "Dunkel",
    light: "Hell",
    timeSpan: "Zeitraum",
    watchedStations: "Beobachtete Stationen",
    watchedLines: "Beobachtete Linien",
    reset: "Zurücksetzen",
    searchPlaceholder: "Haltestelle suchen...",
    addPlaceholder: "Haltestelle hinzufügen...",
    filterLinesPlaceholder: "Filter (z.B. M41)...",
    noLinesFound: "Keine passenden Linien gefunden.",
    dataSource: "Datenquelle",
    disclaimer: "Alle Angaben ohne Gewähr.",
    favorites: "Favoriten",
    loading: "Lade Abfahrten...",
    noDepartures: "Keine Abfahrten in den nächsten {t} Min.",
    cancelled: "fällt aus",
    cancelledMsg: "Diese Fahrt fällt leider aus.",
    now: "Sofort",
    inMin: "In {t} Min",
    loadMore: "Weiter...",
    zoomIn: "Vergrößern",
    zoomOut: "Verkleinern",
  },
  en: {
    settings: "Settings",
    displayLang: "Display & Language",
    dark: "Dark",
    light: "Light",
    timeSpan: "Time Span",
    watchedStations: "Watched Stations",
    watchedLines: "Watched Lines",
    reset: "Reset",
    searchPlaceholder: "Search station...",
    addPlaceholder: "Add station...",
    filterLinesPlaceholder: "Filter (e.g. M41)...",
    noLinesFound: "No matching lines found.",
    dataSource: "Data Source",
    disclaimer: "Information provided without guarantee.",
    favorites: "Favorites",
    loading: "Loading departures...",
    noDepartures: "No departures in the next {t} min.",
    cancelled: "cancelled",
    cancelledMsg: "This trip is cancelled.",
    now: "Now",
    inMin: "In {t} min",
    loadMore: "Load more...",
    zoomIn: "Zoom In",
    zoomOut: "Zoom Out",
  },
};

export const API_ENDPOINTS = [{ name: "BVG", url: "https://v6.bvg.transport.rest" }];

export const PRODUCT_COLORS = {
  bus: "#A5027D",
  tram: "#CC0000",
  subway: "#0063A5",
  suburban: "#008D4F",
  regional: "#EC0016",
  express: "#FFFFFF",
  default: "#555",
};

export const DARK_TILES = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
export const LIGHT_TILES = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
