import { env } from "../config/env";
import { ApiError } from "../utils/errors";

/** A place in the shape the location forms need. */
export type GeoPlace = {
  label: string; // one-line, for search results
  address: string; // street line
  city: string;
  state: string;
  country: string;
  lat: number;
  lng: number;
};

// ---------------------------------------------------------------------------
// Response parsing (pure, tested)
// ---------------------------------------------------------------------------

type GoogleComponent = { long_name: string; types: string[] };
type GoogleResult = {
  formatted_address: string;
  address_components: GoogleComponent[];
  geometry: { location: { lat: number; lng: number } };
};

export function fromGoogle(r: GoogleResult): GeoPlace {
  const pick = (...types: string[]) =>
    types.map((t) => r.address_components.find((c) => c.types.includes(t))?.long_name).find(Boolean) ?? "";
  const street = [pick("street_number"), pick("route")].filter(Boolean).join(" ");
  return {
    label: r.formatted_address,
    address: street || pick("premise", "point_of_interest", "establishment", "neighborhood", "sublocality"),
    city: pick("locality", "postal_town", "administrative_area_level_2", "sublocality"),
    state: pick("administrative_area_level_1"),
    country: pick("country"),
    lat: r.geometry.location.lat,
    lng: r.geometry.location.lng,
  };
}

type NominatimResult = {
  display_name: string;
  lat: string;
  lon: string;
  name?: string;
  address?: Record<string, string>;
};

export function fromNominatim(r: NominatimResult): GeoPlace {
  const a = r.address ?? {};
  const street = [a.house_number, a.road].filter(Boolean).join(" ");
  return {
    label: r.display_name,
    address: street || r.name || a.suburb || a.neighbourhood || "",
    city: a.city || a.town || a.village || a.county || a.suburb || "",
    state: a.state || "",
    country: a.country || "",
    lat: Number(r.lat),
    lng: Number(r.lon),
  };
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

const cache = new Map<string, { at: number; value: GeoPlace[] }>();
const CACHE_MS = 24 * 60 * 60 * 1000;

async function cached(key: string, load: () => Promise<GeoPlace[]>) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await load();
  if (cache.size > 1000) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function getJson(url: string, headers: Record<string, string> = {}) {
  let res: globalThis.Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  } catch {
    throw new ApiError(502, "GEO_UNAVAILABLE", "The address lookup service is unavailable. Try again shortly.");
  }
  if (!res.ok) throw new ApiError(502, "GEO_UNAVAILABLE", "The address lookup service is unavailable. Try again shortly.");
  return res.json();
}

// OpenStreetMap's free geocoder asks for an identifying User-Agent and light use.
const NOMINATIM_HEADERS = { "User-Agent": "GreenRev/1.0 (support@greenrevs.com)", "Accept-Language": "en" };

async function googleGeocode(params: Record<string, string>): Promise<GeoPlace[]> {
  const qs = new URLSearchParams({ ...params, key: env.googleMapsServerKey!, region: "ng" });
  const json = (await getJson(`https://maps.googleapis.com/maps/api/geocode/json?${qs}`)) as {
    status: string;
    results?: GoogleResult[];
  };
  if (json.status === "ZERO_RESULTS") return [];
  if (json.status !== "OK") {
    console.error("Google geocoding failed:", json.status);
    throw new ApiError(502, "GEO_UNAVAILABLE", "The address lookup service is unavailable. Try again shortly.");
  }
  return (json.results ?? []).slice(0, 5).map(fromGoogle);
}

export async function searchPlaces(query: string): Promise<GeoPlace[]> {
  const q = query.trim().slice(0, 200);
  if (q.length < 3) return [];
  return cached(`s:${q.toLowerCase()}`, async () => {
    if (env.googleMapsServerKey) return googleGeocode({ address: q });
    const qs = new URLSearchParams({ q, format: "jsonv2", addressdetails: "1", limit: "5" });
    const json = (await getJson(`https://nominatim.openstreetmap.org/search?${qs}`, NOMINATIM_HEADERS)) as NominatimResult[];
    return json.map(fromNominatim);
  });
}

export async function reverseGeocode(lat: number, lng: number): Promise<GeoPlace | null> {
  // ~10 m precision is plenty for an address and keeps the cache useful.
  const la = lat.toFixed(4);
  const ln = lng.toFixed(4);
  const [place] = await cached(`r:${la},${ln}`, async () => {
    if (env.googleMapsServerKey) return googleGeocode({ latlng: `${la},${ln}` });
    const qs = new URLSearchParams({ lat: la, lon: ln, format: "jsonv2", addressdetails: "1" });
    const json = (await getJson(`https://nominatim.openstreetmap.org/reverse?${qs}`, NOMINATIM_HEADERS)) as NominatimResult & {
      error?: string;
    };
    return json.error ? [] : [fromNominatim(json)];
  });
  // Keep the exact pin the user chose, not the geocoder's snapped point.
  return place ? { ...place, lat, lng } : null;
}
