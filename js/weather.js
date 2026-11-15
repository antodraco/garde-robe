// Météo : Open-Meteo (gratuit, sans clé).
const WMO = {
  0: ['Ciel clair', 'sunny'], 1: ['Plutôt dégagé', 'partly_cloudy_day'], 2: ['Partiellement nuageux', 'partly_cloudy_day'],
  3: ['Couvert', 'cloud'], 45: ['Brouillard', 'foggy'], 48: ['Brouillard givrant', 'foggy'],
  51: ['Bruine légère', 'rainy_light'], 53: ['Bruine', 'rainy_light'], 55: ['Bruine forte', 'rainy'],
  56: ['Bruine verglaçante', 'weather_mix'], 57: ['Bruine verglaçante', 'weather_mix'],
  61: ['Pluie faible', 'rainy_light'], 63: ['Pluie', 'rainy'], 65: ['Forte pluie', 'rainy_heavy'],
  66: ['Pluie verglaçante', 'weather_mix'], 67: ['Pluie verglaçante', 'weather_mix'],
  71: ['Neige faible', 'weather_snowy'], 73: ['Neige', 'weather_snowy'], 75: ['Forte neige', 'snowing_heavy'], 77: ['Grains de neige', 'weather_snowy'],
  80: ['Averses', 'rainy'], 81: ['Averses', 'rainy'], 82: ['Fortes averses', 'rainy_heavy'],
  85: ['Averses de neige', 'weather_snowy'], 86: ['Averses de neige', 'snowing_heavy'],
  95: ['Orage', 'thunderstorm'], 96: ['Orage avec grêle', 'thunderstorm'], 99: ['Orage avec grêle', 'thunderstorm'],
};

export function describe(code) {
  return WMO[code] || ['Météo inconnue', 'help'];
}

const cache = new Map();

export async function fetchWeather(lat, lon) {
  const key = `${lat},${lon}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 3600_000) return hit.data;
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,' +
    'precipitation_probability_max,precipitation_sum,wind_speed_10m_max&timezone=Europe%2FParis&forecast_days=16';
  const res = await fetch(url);
  if (!res.ok) throw new Error('Météo indisponible (' + res.status + ')');
  const j = await res.json();
  const d = j.daily || {};
  const out = {};
  (d.time || []).forEach((date, i) => {
    out[date] = {
      code: d.weather_code?.[i],
      tmax: d.temperature_2m_max?.[i], tmin: d.temperature_2m_min?.[i],
      ressentiMax: d.apparent_temperature_max?.[i], ressentiMin: d.apparent_temperature_min?.[i],
      pluieProba: d.precipitation_probability_max?.[i], pluieMm: d.precipitation_sum?.[i],
      vent: d.wind_speed_10m_max?.[i],
    };
  });
  cache.set(key, { at: Date.now(), data: out });
  return out;
}

export async function geocode(query) {
  const url = 'https://geocoding-api.open-meteo.com/v1/search?count=6&language=fr&format=json&name=' + encodeURIComponent(query);
  const res = await fetch(url);
  if (!res.ok) throw new Error('Recherche de lieu indisponible');
  const j = await res.json();
  return (j.results || []).map(r => ({
    name: r.name, lat: r.latitude, lon: r.longitude,
    detail: [r.admin2, r.admin1, r.country].filter(Boolean).join(', '),
  }));
}

export function weatherLine(w) {
  if (!w) return 'pas de prévision';
  const [label] = describe(w.code);
  const r = (n) => (n == null ? '?' : Math.round(n));
  return `${label}, ${r(w.tmin)}° à ${r(w.tmax)}°C (ressenti ${r(w.ressentiMin)}° à ${r(w.ressentiMax)}°), ` +
    `pluie ${r(w.pluieProba)} % (${w.pluieMm ?? 0} mm), vent ${r(w.vent)} km/h`;
}
