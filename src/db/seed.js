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

  const post = (id, authorName, title, body, crop, district, problemType, days, likeCount) => ({
    id, authorName, title, body, crop, district, problemType,
    createdAt: ago(days * DAY), likeCount, likedBy: [],
  });
  const posts = [
    post('post-1', 'Ramesh Patil', 'Yellowing leaves on wheat — nitrogen deficiency?',
      'The lower leaves on my wheat crop have started turning pale yellow from the tip inward. Soil scan showed low nitrogen last month. Is a urea top-dressing enough at this stage, or should I wait for the next irrigation cycle?',
      'Wheat', 'Pune', 'nutrientDeficiency', 2, 12),
    post('post-2', 'Suresh Jadhav', 'Best time to spray for bollworm in cotton?',
      'Started seeing small holes in cotton bolls this week. Local shop suggested a broad-spectrum spray but I want to try the neem-based option first if the infestation is still early.',
      'Cotton', 'Aurangabad', 'pest', 5, 18),
    post('post-3', 'Anita Kale', 'Onion prices crashed this week in Nashik mandi',
      'Got barely half of what I expected at the Lasalgaon market this week. Anyone holding back their harvest, or is it better to just sell before it drops further?',
      'Onion', 'Nashik', 'market', 1, 24),
    post('post-4', 'Vikram Deshmukh', 'Unseasonal rain damaged my sugarcane — insurance claim process?',
      'Heavy rain and waterlogging flattened part of my sugarcane field last week. I have Fasal Bima coverage but have never filed a claim before — what documents did others need?',
      'Sugarcane', 'Kolhapur', 'weather', 8, 15),
    post('post-5', 'Meera Shinde', 'White fungus spots on soybean leaves',
      "Noticed powdery white patches spreading across soybean leaves after the last humid spell. Doesn't look like the usual rust — anyone dealt with something similar this season?",
      'Soybean', 'Pune', 'disease', 3, 9),
    post('post-6', 'Lakshmi Naik', 'Anyone using drip irrigation for wheat successfully?',
      "Considering switching from flood irrigation to drip for the next wheat season to save on water. Would love to hear about real yield and cost experiences, not just the sales pitch.",
      'Wheat', 'Pune', 'general', 12, 21),
  ];

  const replyTemplates = [
    'Faced the same thing last season — sorting it out early made a big difference.',
    'Worth asking at the local Krishi Vigyan Kendra, they usually know the latest guidance.',
    "I'd wait a few days and monitor before doing anything drastic.",
    'This happened to my neighbor too — the extension officer helped a lot.',
    'Following this thread, dealing with something similar right now.',
    'Thanks for posting, this is useful for anyone in the area.',
  ];
  const replies = posts.flatMap((p, pi) =>
    [0, 1, 2, 3].map((i) => ({
      id: `${p.id}-reply-${i}`,
      postId: p.id,
      authorName: reviewers[(pi + i) % reviewers.length],
      body: replyTemplates[(pi + i + 2) % replyTemplates.length],
      createdAt: new Date(new Date(p.createdAt).getTime() + (3 + i * 5) * HOUR).toISOString(),
    })),
  );

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

  const farmer = (id, name, village, phone, activeCrop, days, needsFollowUp, notes) => ({
    id, name, village, phone, activeCrop, lastVisitDate: ago(days * DAY), needsFollowUp, notes,
  });
  const farmers = [
    farmer('farmer-ramesh', 'Ramesh Patil', 'Shirur, Pune', '+91 98221 XXXXX', 'Wheat', 4, false, 'Following up on nitrogen top-dressing recommendation.'),
    farmer('farmer-suresh', 'Suresh Jadhav', 'Paithan, Aurangabad', '+91 98230 XXXXX', 'Cotton', 18, true, "Asked about bollworm spray results — hasn't reported back."),
    farmer('farmer-anita', 'Anita Kale', 'Lasalgaon, Nashik', '+91 98221 XXXXX', 'Onion', 1, false, 'Picked up NPK order today.'),
    farmer('farmer-vikram', 'Vikram Deshmukh', 'Karvir, Kolhapur', '+91 98812 XXXXX', 'Sugarcane', 35, true, 'Waiting to hear how the insurance claim for rain damage went.'),
    farmer('farmer-meera', 'Meera Shinde', 'Shirur, Pune', '+91 98501 XXXXX', 'Soybean', 9, true, 'Reported a fungal spot issue — check if it has spread.'),
    farmer('farmer-lakshmi', 'Lakshmi Naik', 'Shirur, Pune', '+91 98904 XXXXX', 'Wheat', 2, false, 'Considering drip irrigation for next season.'),
  ];

  const inventory = [
    { id: 'inv-vermicompost', name: 'Vermicompost', unit: 'bag', unitPrice: 450, currentStock: 40, lowStockThreshold: 15 },
    { id: 'inv-neemcake', name: 'Neem Cake', unit: 'bag', unitPrice: 600, currentStock: 5, lowStockThreshold: 8 },
    { id: 'inv-biopesticide', name: 'Bio-Pesticide Spray', unit: 'bottle', unitPrice: 320, currentStock: 12, lowStockThreshold: 5 },
  ];

  const restockRequests = [
    {
      id: 'restock-1', itemId: 'inv-neemcake', itemName: 'Neem Cake', requestedQuantity: 30,
      status: 'approved', requestedDate: ago(2 * DAY),
    },
  ];

  const line = (productName, quantity, unitPrice) => ({ productName, quantity, unitPrice });
  const order = (id, customerName, type, status, items, createdAt, pickupOtp) => ({
    id, customerName, type, status, items, createdAt, pickupOtp, deviceId: null,
  });
  const orders = [
    order('order-1', 'Ramesh Patil', 'appOrder', 'pending', [line('Neem Cake', 2, 600)], ago(2 * HOUR), '4821'),
    order('order-2', 'Suresh Jadhav', 'appOrder', 'pending', [line('Vermicompost', 1, 450), line('Bio-Pesticide Spray', 1, 320)], ago(1 * HOUR), '7093'),
    order('order-3', 'Anita Kale', 'appOrder', 'readyForPickup', [line('Neem Cake', 1, 600)], ago(4 * HOUR), '2246'),
    order('order-4', 'Vikram Deshmukh', 'appOrder', 'completed', [line('Vermicompost', 3, 450)], ago(6 * HOUR), null),
    order('order-5', 'Walk-in customer', 'walkIn', 'completed', [line('Vermicompost', 1, 450)], ago(3 * HOUR), null),
    order('order-6', 'Meera Shinde', 'walkIn', 'completed', [line('Bio-Pesticide Spray', 2, 320)], ago(45 * 60 * 1000), null),
  ];

  return {
    products, reviews, posts, replies, schemes, farmers, inventory, restockRequests, orders,
    applications: [],
    profiles: [],
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
    for (const p of d.posts) {
      await c.query('INSERT INTO posts (id, author_name, title, body, crop, district, problem_type, created_at, like_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [p.id, p.authorName, p.title, p.body, p.crop, p.district, p.problemType, p.createdAt, p.likeCount]);
    }
    for (const r of d.replies) {
      await c.query('INSERT INTO replies (id, post_id, author_name, body, created_at) VALUES ($1,$2,$3,$4,$5)',
        [r.id, r.postId, r.authorName, r.body, r.createdAt]);
    }
    for (const s of d.schemes) {
      await c.query(
        `INSERT INTO schemes (id, name, agency, category, description, benefit, eligibility_criteria, max_land_holding_hectares, application_deadline)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [s.id, s.name, s.agency, s.category, s.description, s.benefit, s.eligibilityCriteria, s.maxLandHoldingHectares, s.applicationDeadline],
      );
    }
    for (const f of d.farmers) {
      await c.query('INSERT INTO farmers (id, name, village, phone, active_crop, last_visit_date, needs_follow_up, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [f.id, f.name, f.village, f.phone, f.activeCrop, f.lastVisitDate, f.needsFollowUp, f.notes]);
    }
    for (const i of d.inventory) {
      await c.query('INSERT INTO inventory_items (id, name, unit, unit_price, current_stock, low_stock_threshold) VALUES ($1,$2,$3,$4,$5,$6)',
        [i.id, i.name, i.unit, i.unitPrice, i.currentStock, i.lowStockThreshold]);
    }
    for (const r of d.restockRequests) {
      await c.query('INSERT INTO restock_requests (id, item_id, item_name, requested_quantity, status, requested_date) VALUES ($1,$2,$3,$4,$5,$6)',
        [r.id, r.itemId, r.itemName, r.requestedQuantity, r.status, r.requestedDate]);
    }
    for (const o of d.orders) {
      await c.query('INSERT INTO orders (id, customer_name, type, status, created_at, pickup_otp, owner_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [o.id, o.customerName, o.type, o.status, o.createdAt, o.pickupOtp, o.deviceId]);
      for (const [i, item] of o.items.entries()) {
        await c.query('INSERT INTO order_items (order_id, position, product_name, quantity, unit_price) VALUES ($1,$2,$3,$4,$5)',
          [o.id, i, item.productName, item.quantity, item.unitPrice]);
      }
    }
  });
};

module.exports = { buildSeed, seedIfEmpty };
