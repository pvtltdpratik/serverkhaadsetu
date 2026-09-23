const crypto = require('crypto');
const sharp = require('sharp');
const { HttpError } = require('../utils/http');

// In-process port of the original Soil Sense Python analyzer (a colour
// heuristic over a 256x256 RGB thumbnail). The maths is kept identical so
// scores stay comparable with scans the old service produced. To swap in a
// real ML model later, replace `computeMetrics` and keep the returned shape.

const SIZE = 256;

const clip = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const normalize = (v, lo, hi) => clip(((v - lo) / (hi - lo)) * 100, 0, 100);

// Decides what the bytes really are: Flutter uploads everything as
// application/octet-stream, so the declared type can't be trusted or required.
const sniffImageType = (buf) => {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 6 && ['GIF87a', 'GIF89a'].includes(buf.toString('latin1', 0, 6))) return 'image/gif';
  return null;
};

// Decodes to a SIZE x SIZE interleaved RGB byte array. Bicubic ("cubic" in
// sharp) matches Pillow's default resize filter; alpha is dropped, not
// composited, like Pillow's convert("RGB").
const loadPixels = async (buffer) => {
  try {
    const { data, info } = await sharp(buffer)
      .removeAlpha()
      .toColourspace('srgb')
      .resize(SIZE, SIZE, { fit: 'fill', kernel: 'cubic' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 3) throw new Error(`expected 3 channels, got ${info.channels}`);
    return data;
  } catch (err) {
    console.error('Could not decode uploaded image:', err.message);
    throw new HttpError(422, 'Uploaded file is not a valid image');
  }
};

const detectDisease = (data, count) => {
  let anomalies = 0;
  for (let i = 0; i < data.length; i += 3) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    // Thresholds are the 0-1 originals (0.4, 0.25) scaled to 0-255 bytes.
    const brown = r > 102 && r > g && g > b && b < 102;
    const dark = r < 63.75 && g < 63.75 && b < 63.75;
    if (brown || dark) anomalies += 1;
  }
  const ratio = anomalies / count;

  if (ratio > 0.12) return { disease: 'Fungal infection suspected', confidence: clip(ratio * 100 * 1.2, 20, 95) };
  if (ratio > 0.05) return { disease: 'Leaf spot indicators', confidence: clip(ratio * 100 * 1.1, 10, 75) };
  return { disease: 'No disease detected', confidence: clip(100 - ratio * 120, 60, 99) };
};

const recommend = (m) => {
  const recs = [];
  if (m.soil_moisture < 35) recs.push('Increase irrigation to reach optimal moisture levels.');
  else if (m.soil_moisture > 75) recs.push('Reduce watering; soil moisture is above optimal range.');

  if (m.health_score < 50) recs.push('Inspect plants for pests or nutrient deficiencies; health is low.');

  if (m.nutrient_n < 40) recs.push('Apply nitrogen-rich fertilizer to boost foliar growth.');
  if (m.nutrient_p < 40) recs.push('Incorporate phosphorus supplements for root development.');
  if (m.nutrient_k < 40) recs.push('Add potassium fertilizer to improve disease resistance.');

  const disease = m.disease.toLowerCase();
  if (disease.includes('infection') || disease.includes('spot')) {
    recs.push('Apply recommended fungicide and remove affected leaves.');
  }

  if (recs.length === 0) recs.push('Conditions look healthy. Maintain current agronomic practices.');
  return recs;
};

const computeMetrics = (data) => {
  const count = data.length / 3;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumSq = 0;
  for (let i = 0; i < data.length; i += 3) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    sumR += r;
    sumG += g;
    sumB += b;
    sumSq += r * r + g * g + b * b;
  }
  const red = sumR / count;
  const green = sumG / count;
  const blue = sumB / count;
  const brightness = (sumR + sumG + sumB) / data.length;
  // Population std-dev over every channel value, as numpy's np.std does.
  const saturation = Math.sqrt(Math.max(sumSq / data.length - brightness * brightness, 0)) / 255;

  const { disease, confidence } = detectDisease(data, count);
  const metrics = {
    soil_moisture: clip((0.6 * (green / 255) + 0.4 * (brightness / 255)) * 100, 5, 95),
    health_score: clip((0.7 * (green / 255) + 0.3 * saturation) * 100, 10, 98),
    nutrient_n: normalize(green, 60, 200),
    nutrient_p: normalize(red, 50, 190),
    nutrient_k: normalize(blue, 40, 180),
    disease,
    disease_confidence: confidence,
  };
  return { ...metrics, recommendations: recommend(metrics) };
};

// Analyses a photo in-process and returns the scan result. `deviceId` and
// `cropType` are accepted for API stability; the heuristic doesn't use them.
async function analyzeImage({ buffer }) {
  if (!sniffImageType(buffer)) throw new HttpError(400, 'Unsupported image format. Use JPEG, PNG, WebP or GIF.');
  const pixels = await loadPixels(buffer);
  return {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    ...computeMetrics(pixels),
  };
}

module.exports = { analyzeImage, sniffImageType };
