// Pure helpers extracted from main.js
// Keep logic identical to preserve behavior.

export function cleanName(name) {
  if (!name) return "";
  return name.replace(/\s*\(Berlin\)\s*/gi, "").replace(/,\s*Berlin\s*/gi, "");
}

export function getBoundingBox(lat, lon, radiusKm) {
  const latDelta = radiusKm / 111;
  const lonDelta = radiusKm / (111 * Math.cos(lat * (Math.PI / 180)));
  return {
    north: lat + latDelta,
    south: lat - latDelta,
    east: lon + lonDelta,
    west: lon - lonDelta,
  };
}
