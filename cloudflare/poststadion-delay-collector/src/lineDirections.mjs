const ROUTE_123_TO_MAECKERITZWIESEN = [
  'S+U Hauptbahnhof', 'Lehrter Str./Invalidenstr.', 'Seydlitzstr.', 'Poststadion',
  'Kruppstr.', 'Birkenstr./Rathenower Str.', 'Kriminalgericht Moabit', 'Wilsnacker Str.',
  'Lübecker Str.', 'U Turmstr.', 'Rathaus Tiergarten', 'Turmstr./Beusselstr.',
  'Wittstocker Str.', 'S Beusselstr.', 'Berliner Großmarkt', 'Seestr./Beusselstr.',
  'Gedenkstätte Plötzensee', 'Buchholzweg', 'Fr.-Olbricht-D./Saatwinkler Damm', 'Stieffring',
  'Friedrich-Olbricht-D./Heckerdamm', 'Thaters Privatweg', 'Kolonie Zukunft', 'Gloedenpfad',
  'Wirmerzeile', 'Reichweindamm', 'Goerdelerdamm', 'U Jakob-Kaiser-Platz',
  'Weltlingerbrücke', 'Habermannzeile', 'Hofackerzeile', 'Dahrendorfzeile', 'U Halemweg',
  'Toeplerstr./Halemweg', 'Schweiggerweg', 'Goebelplatz', 'Popitzweg', 'U Siemensdamm',
  'Quellweg', 'U Rohrdamm', 'Straße am Schaltwerk', 'Köttgenstr.', 'Harriesstr.',
  'Saatwinkler Damm/Rohrdamm', 'Siedlung Saatwinkler Damm', 'Mäckeritzbrücke', 'Mäckeritzwiesen',
];

const ROUTE_142_TO_OSTBAHNHOF = [
  'U Leopoldplatz', 'Luxemburger Str.', 'U Amrumer Str.', 'Samoastr.', 'Kiautschoustr.',
  'Fennbrücke', 'Perleberger Brücke', 'Kruppstr.', 'Poststadion', 'Seydlitzstr.',
  'Lehrter Str./Invalidenstr.', 'S+U Hauptbahnhof', 'Invalidenpark', 'Robert-Koch-Platz',
  'Philippstr.', 'Hannoversche Str.', 'Tucholskystr.', 'U Rosenthaler Platz',
  'U Rosa-Luxemburg-Platz', 'Mollstr./Prenzlauer Allee', 'Mollstr./Otto-Braun-Str.',
  'Am Friedrichshain', 'Weinstr.', 'Platz der Vereinten Nationen', 'Friedrichsberger Str.',
  'U Strausberger Platz', 'Singerstr.', 'Andreasstr./Lange Str.', 'Stralauer Platz', 'S Ostbahnhof',
];

function stopsAfterPoststadion(stopSequence) {
  const poststadionIndex = stopSequence.findIndex((stop) => normalizeRouteName(stop) === 'poststadion');
  return poststadionIndex < 0 ? [] : stopSequence.slice(poststadionIndex + 1);
}

// BVG official line pages, retrieved 2026-09-30. Platform assignments are Poststadion-specific.
export const LINE_DIRECTIONS = [
  {
    key: '123_to_hauptbahnhof',
    line: '123',
    label: 'Richtung S+U Hauptbahnhof',
    platform: '1',
    terminalNames: ['S+U Hauptbahnhof', 'Hauptbahnhof'],
    stopSequence: [...ROUTE_123_TO_MAECKERITZWIESEN].reverse(),
    destinationStopSequence: stopsAfterPoststadion([...ROUTE_123_TO_MAECKERITZWIESEN].reverse()),
  },
  {
    key: '123_to_maeckeritzwiesen',
    line: '123',
    label: 'Richtung Saatwinkler Damm/Mäckeritzwiesen',
    platform: '2',
    terminalNames: ['Mäckeritzwiesen', 'Saatwinkler Damm/Mäckeritzwiesen'],
    // U Paulsternstr. has appeared as a temporary terminal in the live feed.
    additionalDestinationNames: ['U Paulsternstr.'],
    stopSequence: ROUTE_123_TO_MAECKERITZWIESEN,
    destinationStopSequence: stopsAfterPoststadion(ROUTE_123_TO_MAECKERITZWIESEN),
  },
  {
    key: '142_to_ostbahnhof',
    line: '142',
    label: 'Richtung S Ostbahnhof',
    platform: '1',
    terminalNames: ['S Ostbahnhof'],
    stopSequence: ROUTE_142_TO_OSTBAHNHOF,
    destinationStopSequence: stopsAfterPoststadion(ROUTE_142_TO_OSTBAHNHOF),
  },
  {
    key: '142_to_leopoldplatz',
    line: '142',
    label: 'Richtung U Leopoldplatz',
    platform: '2',
    terminalNames: ['U Leopoldplatz'],
    stopSequence: [...ROUTE_142_TO_OSTBAHNHOF].reverse(),
    destinationStopSequence: stopsAfterPoststadion([...ROUTE_142_TO_OSTBAHNHOF].reverse()),
  },
];

export function normalizeRouteName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function destinationMatches(destination, candidate) {
  const normalizedDestination = normalizeRouteName(destination);
  const normalizedCandidate = normalizeRouteName(candidate);
  return normalizedDestination === normalizedCandidate
    || normalizedDestination.startsWith(`${normalizedCandidate} `);
}

export function classifyDirection(line, destination) {
  const matchingDirections = LINE_DIRECTIONS.filter((direction) => direction.line === String(line));
  for (const direction of matchingDirections) {
    if (direction.terminalNames.some((name) => destinationMatches(destination, name))) {
      return { ...direction, servicePattern: 'full_route', confidence: 'canonical' };
    }
  }

  for (const direction of matchingDirections) {
    const shortTurnNames = [
      ...(direction.additionalDestinationNames || []),
      ...direction.destinationStopSequence,
    ];
    if (shortTurnNames.some((name) => destinationMatches(destination, name))) {
      return { ...direction, servicePattern: 'short_turn', confidence: 'route_stop' };
    }
  }

  return null;
}
