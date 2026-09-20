const { HttpError } = require('../utils/http');

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

// Maps Open-Meteo WMO weather codes to the app's condition set.
const conditionFor = (code) => {
  if (code === 0 || code === 1) return 'sunny';
  if (code === 2) return 'partlyCloudy';
  if (code === 3 || code === 45 || code === 48) return 'cloudy';
  if (code >= 95) return 'stormy';
  return 'rainy';
};

const getJson = async (url, timeoutMs) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`upstream ${response.status}`);
  return response.json();
};

async function placeName(lat, lon) {
  const fallback = `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`;
    const json = await getJson(url, 10000);
    const city = (json.city || '').trim();
    const region = (json.principalSubdivision || '').trim();
    if (!city) return fallback;
    return region ? `${city}, ${region}` : city;
  } catch {
    return fallback;
  }
}

async function fetchForecast(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
    '&timezone=auto&forecast_days=5';
  let json;
  try {
    json = await getJson(url, 15000);
  } catch {
    throw new HttpError(502, 'The weather service is unavailable right now. Please try again.');
  }

  const daily = json.daily;
  const days = daily.time.map((date, i) => ({
    date,
    condition: conditionFor(daily.weather_code[i]),
    tempHighC: daily.temperature_2m_max[i],
    tempLowC: daily.temperature_2m_min[i],
    rainChancePercent: Math.round(daily.precipitation_probability_max[i] ?? 0),
  }));
  const value = { location: await placeName(lat, lon), days };
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
}

module.exports = { fetchForecast };
