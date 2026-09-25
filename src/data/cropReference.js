// Reference numbers for the calculator and the review screens. They are indicative, so the app lets the
// farmer change the price, and says so.
//
//  * msp: the Minimum Support Price the Government announced for 2025-26, in rupees per quintal
//    (sugarcane is the Fair and Remunerative Price; onion, grapes and vegetables have no MSP, so a
//    typical market price is given).
//  * districtAvgQpa: a typical district average yield for Maharashtra, in quintals per acre
//    (sugarcane in tonnes x 10, i.e. quintals; grapes and vegetables in quintals).
const crops = {
  Soybean: { msp: 5328, districtAvgQpa: 9.2, season: 'kharif' },
  Cotton: { msp: 7710, districtAvgQpa: 4.5, season: 'kharif' },
  Tur: { msp: 8000, districtAvgQpa: 3.6, season: 'kharif' },
  Jowar: { msp: 3699, districtAvgQpa: 6.0, season: 'both' },
  Bajra: { msp: 2775, districtAvgQpa: 5.5, season: 'kharif' },
  Maize: { msp: 2400, districtAvgQpa: 16, season: 'kharif' },
  Groundnut: { msp: 7263, districtAvgQpa: 6.0, season: 'kharif' },
  Wheat: { msp: 2585, districtAvgQpa: 12, season: 'rabi' },
  Gram: { msp: 5650, districtAvgQpa: 5.5, season: 'rabi' },
  Sugarcane: { msp: 355, districtAvgQpa: 350, season: 'annual' },
  Onion: { msp: 1500, districtAvgQpa: 100, season: 'rabi' },
  Grapes: { msp: 5000, districtAvgQpa: 60, season: 'annual' },
  Pomegranate: { msp: 7000, districtAvgQpa: 40, season: 'annual' },
  Vegetables: { msp: 2000, districtAvgQpa: 60, season: 'both' },
};

const lookup = (name) => {
  const wanted = String(name || '').trim().toLowerCase();
  const key = Object.keys(crops).find((k) => k.toLowerCase() === wanted);
  return key ? { name: key, ...crops[key] } : null;
};

const list = () => Object.entries(crops).map(([name, c]) => ({ name, ...c }));

module.exports = { crops, lookup, list };
