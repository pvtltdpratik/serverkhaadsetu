const sharp = require('sharp');
const { HttpError } = require('../utils/http');

const clamp = (v, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;

// Placeholder heuristic model: derives scores from simple colour statistics
// of the photo. It exists so the whole scan flow (upload -> result -> history
// -> home summary) works end to end; replace `analyzeImage` with the trained
// ML model when it is ready — the returned shape is the contract.
async function analyzeImage(buffer, { cropType } = {}) {
  let raw;
  try {
    raw = await sharp(buffer, { failOn: 'error' })
      .rotate()
      .resize(64, 64, { fit: 'cover' })
      .removeAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer();
  } catch {
    throw new HttpError(422, 'Could not read the uploaded file as an image');
  }

  const pixels = raw.length / 3;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let yellow = 0;
  let white = 0;
  for (let i = 0; i < raw.length; i += 3) {
    const r = raw[i];
    const g = raw[i + 1];
    const b = raw[i + 2];
    sumR += r;
    sumG += g;
    sumB += b;
    if (r > 140 && g > 140 && b < 90 && Math.abs(r - g) < 70) yellow++;
    if (r > 215 && g > 215 && b > 215) white++;
  }
  const meanR = sumR / pixels;
  const meanG = sumG / pixels;
  const meanB = sumB / pixels;
  const luminance = 0.299 * meanR + 0.587 * meanG + 0.114 * meanB;
  const yellowShare = yellow / pixels;
  const whiteShare = white / pixels;

  const moisture = clamp(100 - (luminance / 255) * 90);
  const nitrogen = clamp(55 + (meanG - (meanR + meanB) / 2) * 2.5);
  const phosphorus = clamp(45 + (meanR - meanB) * 0.6);
  const potassium = clamp(35 + luminance * 0.3);

  let disease = 'No significant disease indicators';
  let diseaseConfidence = clamp(100 - Math.max(yellowShare, whiteShare) * 100, 60, 95);
  let diseaseTip = null;
  if (yellowShare > 0.15) {
    disease = 'Leaf yellowing indicators';
    diseaseConfidence = clamp(50 + yellowShare * 100, 0, 95);
    diseaseTip = 'Yellowing can point to nutrient stress or a fungal issue — inspect the leaves closely and consider a neem-oil spray.';
  } else if (whiteShare > 0.12) {
    disease = 'Powdery fungal residue indicators';
    diseaseConfidence = clamp(50 + whiteShare * 100, 0, 95);
    diseaseTip = 'Whitish patches may be powdery mildew — spray diluted neem oil or a buttermilk solution and improve airflow between plants.';
  }

  const diseasePenalty = diseaseTip ? diseaseConfidence * 0.5 : 0;
  const npkAverage = (nitrogen + phosphorus + potassium) / 3;
  const moistureScore = clamp(100 - Math.abs(moisture - 55) * 2);
  const health = clamp(0.45 * npkAverage + 0.25 * moistureScore + 0.3 * (100 - diseasePenalty));

  const recommendations = [];
  const nutrientTips = [
    [nitrogen, 'Nitrogen is low — apply vermicompost or neem cake before the next watering.'],
    [phosphorus, 'Phosphorus is low — mix bone meal or rock phosphate into compost and work it into the soil.'],
    [potassium, 'Potassium is low — add wood ash or well-rotted compost around the root zone.'],
  ];
  nutrientTips.filter(([v]) => v < 40).sort((a, b) => a[0] - b[0]).forEach(([, tip]) => recommendations.push(tip));
  if (moisture < 30) recommendations.push('Soil looks dry — irrigate lightly and add mulch to hold moisture.');
  if (moisture > 80) recommendations.push('Soil looks waterlogged — improve drainage before the next irrigation.');
  if (diseaseTip) recommendations.push(diseaseTip);
  if (recommendations.length === 0) {
    recommendations.push(
      `No major issues detected${cropType ? ` for your ${cropType}` : ''} — keep up your current routine and rescan in two weeks.`,
    );
  }

  return {
    health_score: round1(health),
    soil_moisture: round1(moisture),
    nutrient_n: round1(nitrogen),
    nutrient_p: round1(phosphorus),
    nutrient_k: round1(potassium),
    disease,
    disease_confidence: round1(diseaseConfidence),
    recommendations,
  };
}

module.exports = { analyzeImage };
