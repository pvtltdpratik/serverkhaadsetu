const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const buildSeed = (now = Date.now()) => {
  const ago = (ms) => new Date(now - ms).toISOString();
  const ahead = (ms) => new Date(now + ms).toISOString();

  const products = [
    {
      id: 'p-vermicompost', name: 'Vermicompost', brand: 'HaritBhoomi', category: 'organic',
      priceInRupees: 450, unitLabel: '40 kg bag', rating: 4.7, reviewCount: 340,
      description: "Builds organic matter and soil structure over time. A gentle, slow-release option that's safe to combine with any other fertilizer.",
      nutrientFocus: ['nitrogen'], npkPercentages: { nitrogen: 1, phosphorus: 0.5, potassium: 0.5 },
    },
    {
      id: 'p-neemcake', name: 'Neem Cake', brand: 'KisanShield', category: 'organic',
      priceInRupees: 600, unitLabel: '25 kg bag', rating: 4.1, reviewCount: 58,
      description: 'Organic soil conditioner with natural pest-deterrent properties. Works well mixed into soil before sowing.',
      nutrientFocus: ['nitrogen'], npkPercentages: { nitrogen: 2 },
    },
    {
      id: 'p-wheatseed', name: 'Hybrid Wheat Seeds HD-2967', brand: 'SafalKheti', category: 'seed',
      priceInRupees: 85, unitLabel: 'per kg', rating: 4.4, reviewCount: 150,
      description: 'High-yield, disease-resistant wheat variety suited to irrigated conditions. Recommended seed rate: 100 kg/acre.',
      nutrientFocus: [], npkPercentages: {},
    },
    {
      id: 'p-biopesticide', name: 'Bio-Pesticide Spray', brand: 'KisanShield', category: 'pesticide',
      priceInRupees: 320, unitLabel: '1 L bottle', rating: 3.9, reviewCount: 65,
      description: 'Neem-oil based spray for common leaf-eating pests. Safer for beneficial insects than broad-spectrum chemicals.',
      nutrientFocus: [], npkPercentages: {},
    },
    {
      id: 'p-sprayer', name: 'Hand Sprayer 5L', brand: 'AgroVeda', category: 'equipment',
      priceInRupees: 650, unitLabel: 'per unit', rating: 4.3, reviewCount: 90,
      description: 'Durable manual compression sprayer for pesticide and foliar fertilizer application, with an adjustable nozzle.',
      nutrientFocus: [], npkPercentages: {},
    },
  ];

  const reviewers = ['Sunil P.', 'Anita K.', 'Ravindra J.', 'Meera S.', 'Vikram D.', 'Lakshmi N.'];
  const comments = [
    'Good results after one season of use. Will buy again.',
    'Reasonably priced compared to what the local shop sells.',
    'Worked well, though delivery to my village took a while.',
    'My neighbor recommended this — glad I tried it.',
    'Does the job, nothing extraordinary but reliable.',
    'Noticed a clear improvement within a couple of weeks.',
  ];
  const reviews = products.flatMap((p, pi) =>
    [0, 1, 2].map((i) => ({
      id: `${p.id}-review-${i}`,
      productId: p.id,
      authorName: reviewers[(pi + i) % reviewers.length],
      rating: 3 + ((pi + i) % 3),
      comment: comments[(pi + i * 2) % comments.length],
      date: ago((5 + i * 12) * DAY),
    })),
  );

  // farmerId here is what a Supabase user id (or anonymous device id) would
  // look like — matching profiles rows below give these display names via
  // the same LEFT JOIN a real signed-in farmer's posts resolve through.
  const post = (id, farmerId, title, content, cropTag, districtTag, problemTypeTag, days) => ({
    id, farmerId, title, content, cropTag, districtTag, problemTypeTag, createdAt: ago(days * DAY),
  });
  const communityPosts = [
    post('post-1', 'farmer-ramesh', 'Yellowing leaves on wheat — nitrogen deficiency?',
      'The lower leaves on my wheat crop have started turning pale yellow from the tip inward. Soil scan showed low nitrogen last month. Is a urea top-dressing enough at this stage, or should I wait for the next irrigation cycle?',
      'Wheat', 'Pune', 'nutrientDeficiency', 2),
    post('post-2', 'farmer-suresh', 'Best time to spray for bollworm in cotton?',
      'Started seeing small holes in cotton bolls this week. Local shop suggested a broad-spectrum spray but I want to try the neem-based option first if the infestation is still early.',
      'Cotton', 'Aurangabad', 'pest', 5),
    post('post-3', 'farmer-anita', 'Onion prices crashed this week in Nashik mandi',
      'Got barely half of what I expected at the Lasalgaon market this week. Anyone holding back their harvest, or is it better to just sell before it drops further?',
      'Onion', 'Nashik', 'market', 1),
    post('post-4', 'farmer-vikram', 'Unseasonal rain damaged my sugarcane — insurance claim process?',
      'Heavy rain and waterlogging flattened part of my sugarcane field last week. I have Fasal Bima coverage but have never filed a claim before — what documents did others need?',
      'Sugarcane', 'Kolhapur', 'weather', 8),
    post('post-5', 'farmer-meera', 'White fungus spots on soybean leaves',
      "Noticed powdery white patches spreading across soybean leaves after the last humid spell. Doesn't look like the usual rust — anyone dealt with something similar this season?",
      'Soybean', 'Pune', 'disease', 3),
    post('post-6', 'farmer-lakshmi', 'Anyone using drip irrigation for wheat successfully?',
      "Considering switching from flood irrigation to drip for the next wheat season to save on water. Would love to hear about real yield and cost experiences, not just the sales pitch.",
      'Wheat', 'Pune', 'general', 12),
  ];

  // Display names for the fake farmer ids used above and for commenters below.
  const communityProfiles = [
    { ownerId: 'farmer-ramesh', name: 'Ramesh Patil', village: 'Shirur, Pune' },
    { ownerId: 'farmer-suresh', name: 'Suresh Jadhav', village: 'Paithan, Aurangabad' },
    { ownerId: 'farmer-anita', name: 'Anita Kale', village: 'Lasalgaon, Nashik' },
    { ownerId: 'farmer-vikram', name: 'Vikram Deshmukh', village: 'Karvir, Kolhapur' },
    { ownerId: 'farmer-meera', name: 'Meera Shinde', village: 'Shirur, Pune' },
    { ownerId: 'farmer-lakshmi', name: 'Lakshmi Naik', village: 'Shirur, Pune' },
    { ownerId: 'commenter-sunil', name: 'Sunil P.', village: '' },
    { ownerId: 'commenter-anitak', name: 'Anita K.', village: '' },
    { ownerId: 'commenter-ravindra', name: 'Ravindra J.', village: '' },
    { ownerId: 'commenter-meeras', name: 'Meera S.', village: '' },
    { ownerId: 'commenter-vikramd', name: 'Vikram D.', village: '' },
    { ownerId: 'commenter-lakshmin', name: 'Lakshmi N.', village: '' },
  ];
  const commenterIds = ['commenter-sunil', 'commenter-anitak', 'commenter-ravindra', 'commenter-meeras', 'commenter-vikramd', 'commenter-lakshmin'];

  const agronomists = [
    { id: 'agro-sanjay', name: 'Dr. Sanjay Deshpande', verifiedStatus: true, specialization: 'Soil Science & Plant Nutrition' },
  ];

  const commentTemplates = [
    'Faced the same thing last season — sorting it out early made a big difference.',
    'Worth asking at the local Krishi Vigyan Kendra, they usually know the latest guidance.',
    "I'd wait a few days and monitor before doing anything drastic.",
    'This happened to my neighbor too — the extension officer helped a lot.',
    'Following this thread, dealing with something similar right now.',
    'Thanks for posting, this is useful for anyone in the area.',
  ];
  const postComments = communityPosts.flatMap((p, pi) => {
    const farmerComments = [0, 1, 2, 3].map((i) => ({
      id: `${p.id}-comment-${i}`,
      postId: p.id,
      farmerId: commenterIds[(pi + i) % commenterIds.length],
      content: commentTemplates[(pi + i + 2) % commentTemplates.length],
      isAiGenerated: false,
      agronomistId: null,
      createdAt: new Date(new Date(p.createdAt).getTime() + (3 + i * 5) * HOUR).toISOString(),
    }));
    // One post also gets a direct, already-verified agronomist answer, so the
    // "verified" badge has an example to render from a fresh database.
    if (p.id !== 'post-1') return farmerComments;
    return [
      ...farmerComments,
      {
        id: `${p.id}-comment-agro`,
        postId: p.id,
        farmerId: 'agro-sanjay',
        content: 'Wait for the top-dressing until right after the next irrigation — urea spread on dry soil loses a good share of its nitrogen to volatilization before the roots ever see it.',
        isAiGenerated: false,
        agronomistId: 'agro-sanjay',
        createdAt: new Date(new Date(p.createdAt).getTime() + 26 * HOUR).toISOString(),
      },
    ];
  });

  const schemes = [
    {
      id: 'scheme-pmkisan', name: 'PM-KISAN Income Support', agency: 'Dept. of Agriculture & Farmers Welfare',
      category: 'incomeSupport',
      description: 'Direct income support paid to landholding farmer families to help with input costs across the season.',
      benefit: '₹6,000 per year, in 3 installments',
      eligibilityCriteria: ['Must own cultivable agricultural land', 'Family-based landholding; no income-tax payer in the family'],
      maxLandHoldingHectares: null, applicationDeadline: null,
    },
    {
      id: 'scheme-fasalbima', name: 'PM Fasal Bima Yojana', agency: 'Ministry of Agriculture & Farmers Welfare',
      category: 'insurance',
      description: 'Subsidized crop insurance covering yield loss from natural calamities, pests, and disease.',
      benefit: 'Subsidized premium; claim payout based on assessed yield loss',
      eligibilityCriteria: ['Any farmer growing a notified crop in a notified area', 'Enroll through your bank or Common Service Centre before the season cutoff'],
      maxLandHoldingHectares: null, applicationDeadline: ahead(42 * DAY),
    },
    {
      id: 'scheme-pkvy', name: 'Paramparagat Krishi Vikas Yojana', agency: 'Ministry of Agriculture & Farmers Welfare',
      category: 'subsidy',
      description: 'Supports small and marginal farmers converting to organic farming methods through cluster-based groups.',
      benefit: '₹50,000 per hectare over 3 years for organic conversion',
      eligibilityCriteria: ['Land holding up to 2 hectares', 'Willingness to join or form a farmer cluster group'],
      maxLandHoldingHectares: 2.0, applicationDeadline: null,
    },
    {
      id: 'scheme-kcc', name: 'Kisan Credit Card', agency: 'Dept. of Financial Services',
      category: 'creditSupport',
      description: 'Short-term credit for crop production and allied activities at a subsidized interest rate.',
      benefit: 'Loans up to ₹3 lakh at subsidized interest',
      eligibilityCriteria: ['Any farmer with cultivable land, or a tenant/sharecropper', 'Valid land records or a crop-sharing agreement'],
      maxLandHoldingHectares: null, applicationDeadline: null,
    },
    {
      id: 'scheme-mechanization', name: 'Sub-Mission on Agricultural Mechanization', agency: 'Dept. of Agriculture & Farmers Welfare',
      category: 'subsidy',
      description: 'Subsidy for marginal farmers purchasing small farm equipment such as sprayers and power tillers.',
      benefit: '40-50% subsidy on eligible equipment purchases',
      eligibilityCriteria: ['Land holding up to 1 hectare (marginal farmer)', 'Must not have received the same equipment subsidy in the past 5 years'],
      maxLandHoldingHectares: 1.0, applicationDeadline: ahead(20 * DAY),
    },
  ];

  return {
    products, reviews, communityPosts, postComments, agronomists, schemes,
    profiles: communityProfiles,
    applications: [],
    notifications: [],
    scans: [],
  };
};

// Loads the starter data into an empty database (first run only). Existing
// installs — anything with a product already — are left untouched.
const seedIfEmpty = async (db) => {
  await db.tx(async (c) => {
    // Serialise concurrent first starts of several instances.
    await c.query('SELECT pg_advisory_xact_lock(727202)');
    const { rows } = await c.query('SELECT 1 FROM products LIMIT 1');
    if (rows.length) return;
    const d = buildSeed();

    for (const p of d.products) {
      await c.query(
        `INSERT INTO products (id, name, brand, category, price_in_rupees, unit_label, rating, review_count, description, nutrient_focus, npk_percentages)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [p.id, p.name, p.brand, p.category, p.priceInRupees, p.unitLabel, p.rating, p.reviewCount, p.description, p.nutrientFocus, JSON.stringify(p.npkPercentages)],
      );
    }
    for (const r of d.reviews) {
      await c.query('INSERT INTO reviews (id, product_id, author_name, rating, comment, date) VALUES ($1,$2,$3,$4,$5,$6)',
        [r.id, r.productId, r.authorName, r.rating, r.comment, r.date]);
    }
    for (const pr of d.profiles) {
      await c.query('INSERT INTO profiles (owner_id, name, village) VALUES ($1,$2,$3)', [pr.ownerId, pr.name, pr.village]);
    }
    for (const a of d.agronomists) {
      await c.query('INSERT INTO agronomist (agronomist_id, name, verified_status, specialization) VALUES ($1,$2,$3,$4)',
        [a.id, a.name, a.verifiedStatus, a.specialization]);
    }
    for (const p of d.communityPosts) {
      await c.query(
        'INSERT INTO community_post (post_id, farmer_id, title, content, crop_tag, district_tag, problem_type_tag, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [p.id, p.farmerId, p.title, p.content, p.cropTag, p.districtTag, p.problemTypeTag, p.createdAt],
      );
    }
    for (const c2 of d.postComments) {
      await c.query(
        'INSERT INTO post_comment (comment_id, post_id, farmer_id, content, is_ai_generated, is_agronomist_verified, agronomist_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [c2.id, c2.postId, c2.farmerId, c2.content, c2.isAiGenerated, Boolean(c2.agronomistId), c2.agronomistId, c2.createdAt],
      );
    }
    for (const s of d.schemes) {
      await c.query(
        `INSERT INTO schemes (id, name, agency, category, description, benefit, eligibility_criteria, max_land_holding_hectares, application_deadline)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [s.id, s.name, s.agency, s.category, s.description, s.benefit, s.eligibilityCriteria, s.maxLandHoldingHectares, s.applicationDeadline],
      );
    }
  });
};

module.exports = { buildSeed, seedIfEmpty };
