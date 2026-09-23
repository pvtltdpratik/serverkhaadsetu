// Placeholder for the real AI model integration. `generateDraftAnswer` takes
// the just-created post and returns plain text — no database access, no
// network call, no side effects. That boundary is deliberate: swapping this
// out for an actual model/API call later means changing what happens *inside
// this one function*; nothing else in the app (the route, the controller,
// the transaction that stores the result) needs to change.
//
// Today it picks a canned, problem-type-specific starting point and always
// appends a plain-language disclaimer, since this draft is visible to the
// farmer immediately — before any agronomist has looked at it.

const DISCLAIMER =
  'This is an AI-generated draft and has not yet been reviewed by an agronomist. ' +
  'Please treat it as a starting point, not final advice, until it is verified.';

const TEMPLATES = {
  pest: (crop) =>
    'Insect damage like this is often worth checking closely before spraying anything broad-spectrum. ' +
    `A targeted, neem-based option is usually a safer first step${crop ? ` for ${crop}` : ''}, and gives you a ` +
    'day or two to see whether the infestation is actually spreading before reaching for something stronger.',
  disease: (crop) =>
    'Symptoms like these can come from more than one cause, so it helps to rule out the simple things first: ' +
    `check the undersides of the leaves, and see whether it is spreading or holding steady${crop ? ` on your ${crop}` : ''}. ` +
    'A photo through Soil Scan can also help narrow it down.',
  nutrientDeficiency: (crop) =>
    `This does sound like it could be a nutrient gap${crop ? ` in your ${crop}` : ''}. ` +
    'Before applying more fertilizer, a quick soil scan is worth doing — it can tell you which nutrient is ' +
    'actually low, so you are not guessing or overapplying.',
  weather: () =>
    'Weather-related damage is frustrating because there is often little to do after the fact except assess ' +
    'and plan the next step. If you have crop insurance, documenting the damage with photos now (before ' +
    'cleanup) usually helps the claim process later.',
  market: () =>
    'Market prices swing quickly and are hard to call with confidence. Local mandi trends over the last few ' +
    "weeks are usually a better guide than any single day's price, so it may help to check that before deciding.",
  general: () =>
    'Thanks for sharing this — questions like this are exactly what this community is for. Hopefully another ' +
    'farmer or an agronomist who has dealt with something similar can add specifics.',
};

const generateDraftAnswer = ({ cropTag, problemTypeTag }) => {
  const template = TEMPLATES[problemTypeTag] || TEMPLATES.general;
  return `${template(cropTag || '')}\n\n${DISCLAIMER}`;
};

module.exports = { generateDraftAnswer };
