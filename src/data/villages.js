// Approximate town-centre coordinates for places farmers commonly register as
// their village. This is the fallback when GPS is off: a farmer's registered
// village ("Shirur, Pune" or just "Shirur") is looked up here. It is
// deliberately small and curated — there is no geocoding service behind it —
// so an unknown village is reported as such rather than guessed.
const VILLAGES = [
  ['Shirur', 'Pune', 18.8284, 74.376],
  ['Pune', 'Pune', 18.5204, 73.8567],
  ['Baramati', 'Pune', 18.1514, 74.5777],
  ['Daund', 'Pune', 18.4648, 74.5837],
  ['Indapur', 'Pune', 18.1167, 75.0333],
  ['Junnar', 'Pune', 19.2074, 73.8757],
  ['Khed', 'Pune', 18.7226, 73.8686],
  ['Manchar', 'Pune', 19.0038, 73.9427],
  ['Nashik', 'Nashik', 19.9975, 73.7898],
  ['Lasalgaon', 'Nashik', 20.1402, 74.2368],
  ['Sinnar', 'Nashik', 19.8494, 74.0006],
  ['Niphad', 'Nashik', 20.0833, 74.1167],
  ['Yeola', 'Nashik', 20.042, 74.489],
  ['Malegaon', 'Nashik', 20.5579, 74.5089],
  ['Aurangabad', 'Aurangabad', 19.8762, 75.3433],
  ['Paithan', 'Aurangabad', 19.4772, 75.3843],
  ['Jalna', 'Jalna', 19.8347, 75.8816],
  ['Beed', 'Beed', 18.989, 75.7601],
  ['Latur', 'Latur', 18.4088, 76.5604],
  ['Osmanabad', 'Osmanabad', 18.186, 76.0419],
  ['Kolhapur', 'Kolhapur', 16.705, 74.2433],
  ['Karvir', 'Kolhapur', 16.705, 74.2433],
  ['Sangli', 'Sangli', 16.8524, 74.5815],
  ['Satara', 'Satara', 17.6805, 74.0183],
  ['Solapur', 'Solapur', 17.6599, 75.9064],
  ['Ahmednagar', 'Ahmednagar', 19.0948, 74.748],
  ['Jalgaon', 'Jalgaon', 21.0077, 75.5626],
  ['Dhule', 'Dhule', 20.9042, 74.7749],
  ['Akola', 'Akola', 20.7002, 77.0082],
  ['Amravati', 'Amravati', 20.932, 77.7523],
  ['Nagpur', 'Nagpur', 21.1458, 79.0882],
].map(([name, district, latitude, longitude]) => ({ name, district, latitude, longitude }));

const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');

// Accepts "Shirur", "Shirur, Pune" or "shirur , pune". With a district it
// must match both; without one the first place of that name wins.
const findVillage = (text) => {
  if (typeof text !== 'string' || !text.trim()) return null;
  const [name, district] = text.split(',').map(norm);
  return VILLAGES.find((v) => norm(v.name) === name && (!district || norm(v.district) === district)) || null;
};

const searchVillages = (q, limit = 20) => {
  const needle = norm(q || '');
  return VILLAGES.filter((v) => !needle || norm(`${v.name} ${v.district}`).includes(needle)).slice(0, limit);
};

module.exports = { VILLAGES, findVillage, searchVillages };
