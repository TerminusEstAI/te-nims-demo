// TE NIMS · FOB — scenario configuration
//
// Default to OKC tornado scenario. Swap this file (or pass a different
// `scenario` query param) to load a different incident on launch.
//
// Each scenario describes the map's initial view + canonical markers.
// Pin types:
//   incident   — primary incident location (red)
//   staging    — incident command post / staging area (orange)
//   hospital   — receiving hospital (white/blue)
//   shelter    — emergency shelter (green)
//   eoc        — emergency operations center (orange)

export const DEFAULT_SCENARIO = "okc-tornado-2026";

export const SCENARIOS = {
  "okc-tornado-2026": {
    name:       "OKC Tornado",
    incidentId: "OKC-TORNADO-2026",
    // OKC metro view. Mbtiles covers z15-z16 (Google satellite imagery).
    center:     [35.4676, -97.5164],
    zoom:       13,
    minZoom:    11,
    maxZoom:    16,
    markers: [],
  },

  "moore-tornado-2013": {
    name:       "Moore Tornado (historical)",
    incidentId: "MOORE-EF5-2013",
    center:     [35.332, -97.490],
    zoom:       13,
    minZoom:    11,
    maxZoom:    16,
    markers: [],
  },

  // Add more scenarios here. Pattern:
  //   "scenario-id": { name, incidentId, center: [lat, lng], zoom, markers: [...] }
};

// Named POI registry — keyed by scenario id.
// Used to inject geo-context into the LLM system prompt and resolve
// "drop a pin at X" / "zoom to X" requests from the operator.
export const LOCATIONS = {
  "okc-tornado-2026": [
    { name: "Moore Fire Station 1",    lat: 35.3447, lon: -97.4800, type: "staging",  note: "ICP / staging area" },
    { name: "Norman Regional Hospital",lat: 35.2252, lon: -97.4185, type: "hospital", note: "Level 2 trauma · 320 beds" },
    { name: "OU Health OKC",           lat: 35.4983, lon: -97.4982, type: "hospital", note: "Level 1 trauma · 700 beds" },
    { name: "Moore Public Library",    lat: 35.3261, lon: -97.4772, type: "shelter",  note: "Red Cross shelter · 400 capacity" },
    { name: "OKC EOC",                 lat: 35.4660, lon: -97.5140, type: "eoc",      note: "City EOC · activated" },
  ],
  "moore-tornado-2013": [
    { name: "Plaza Towers Elementary", lat: 35.32558, lon: -97.50709, type: "incident", note: "EF5 direct hit — 7 children killed" },
    { name: "Briarwood Elementary",    lat: 35.3210, lon: -97.4994, type: "incident", note: "EF5 direct hit" },
    { name: "Moore Medical Center",    lat: 35.3303, lon: -97.4780, type: "hospital", note: "In tornado path — may be offline" },
    { name: "Moore Fire Station 1",    lat: 35.3447, lon: -97.4800, type: "staging",  note: "Primary staging area" },
    { name: "Moore City Hall",         lat: 35.3372, lon: -97.4868, type: "eoc",      note: "City EOC" },
    { name: "Westmoore High School",   lat: 35.3087, lon: -97.5122, type: "shelter",  note: "Potential shelter / staging" },
    { name: "Norman Regional Hospital",lat: 35.2252, lon: -97.4185, type: "hospital", note: "Level 2 trauma · 320 beds" },
    { name: "OU Medical Center",       lat: 35.4983, lon: -97.4982, type: "hospital", note: "Level 1 trauma · 700 beds" },
    { name: "I-35 and 19th Street",    lat: 35.3247, lon: -97.4893, type: "staging",  note: "Major intersection reference" },
    { name: "Warren Theatre Moore",    lat: 35.3383, lon: -97.4868, type: "staging",  note: "Landmark reference point" },
  ],
};

// Allow ?scenario=moore-tornado-2013 to override the default at runtime
export function activeScenario() {
  const params = new URLSearchParams(window.location.search);
  const id     = params.get("scenario") || DEFAULT_SCENARIO;
  return SCENARIOS[id] || SCENARIOS[DEFAULT_SCENARIO];
}
