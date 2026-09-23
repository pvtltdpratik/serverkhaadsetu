# KHAAD Setu API reference

Base URL: `http://<host>:3000` (locally), or `http://<EC2 public IP>` behind Nginx.
Everything below is under `/v1`, except `GET /health`.

---

## 1. Conventions

### Authentication (Supabase)

Users sign in with Supabase Auth in the app. When the server has `SUPABASE_URL` set, **every `/v1` call** must send the user's access token:

```
Authorization: Bearer <supabase access token>
```

- The server verifies the token's signature against the project's public keys (`<SUPABASE_URL>/auth/v1/.well-known/jwks.json`, cached), its issuer, its `authenticated` audience and its expiry. It never calls Supabase per request and holds no secret.
- The token's `sub` (the Supabase user id) becomes the owner of all farmer-side data: profile, scans, orders, notifications, likes, scheme applications. **`X-Device-Id` / `device_id` are ignored** in this mode, and the `device_id` inside a scan's `metadata_json` is overridden, so one user cannot read or write another's data by naming them.
- Missing, malformed, forged or wrong-project tokens -> `401 {"error":"Please sign in to continue"}` / `"Invalid sign-in token"`. Expired -> `401 "Your session has expired. Please sign in again."` (the app refreshes the session and retries).
- `GET /health` stays open.
- With `SUPABASE_URL` empty (local development, tests) authentication is off and the API uses the anonymous `X-Device-Id` described below.
- Data created before this change was keyed by device id and is not visible to accounts.
- Operator endpoints only require a valid login; there are no roles yet.

### Headers

| Header | When | Notes |
|---|---|---|
| `Content-Type: application/json` | every request with a JSON body | not needed for the multipart soil upload |
| `X-Device-Id: <string>` | every **farmer-side** call marked "device" below, **only when authentication is off** | your existing `deviceIdProvider` value. Alternative: `?device_id=<id>` query param. Missing -> `400` |
| `X-API-Key: <string>` | every `/v1` call, **only if** the server has `API_KEY` set | missing/wrong -> `401` |

Operator endpoints (`/v1/operator/*`) are global to the village center and do **not** need a device id.

### Data formats

- **Dates**: ISO-8601 UTC strings (`"2026-09-20T09:15:00.000Z"`) -> `DateTime.parse` works. The one exception is weather days, which are plain dates (`"2026-09-20"`, also fine for `DateTime.parse`).
- **Enums**: sent as the Dart enum `.name` -> parse with `Enum.values.byName(...)`.
- **Money**: rupees as JSON numbers (`450`, `600.5`).
- **Nulls**: nullable fields are always present with `null` (never omitted), except where noted.
- **Lists**: a plain JSON array (no envelope). Response header `X-Total-Count` has the unpaginated total. Optional `?limit=` (1-200, default 100) and `?offset=`.

### Enum values

| Dart enum | Values |
|---|---|
| `NutrientType` | `nitrogen`, `phosphorus`, `potassium` |
| `WeatherCondition` | `sunny`, `partlyCloudy`, `cloudy`, `rainy`, `stormy` |
| `RecommendationCategory` | `nutrient`, `water`, `pest`, `harvest` |
| `ProductCategory` | `fertilizer`, `organic`, `pesticide`, `seed`, `equipment` |
| `ProblemType` | `pest`, `disease`, `nutrientDeficiency`, `weather`, `market`, `general` |
| `SchemeCategory` | `incomeSupport`, `insurance`, `subsidy`, `creditSupport`, `training` |
| `ApplicationStatus` | `notApplied`, `submitted`, `underReview`, `approved`, `rejected` |
| `OrderType` | `appOrder`, `walkIn` |
| `OrderStatus` | `pending`, `readyForPickup`, `completed`, `cancelled` |
| `RestockRequestStatus` | `pending`, `approved`, `fulfilled` |

### Errors

Every failure is `{ "error": "<human-readable message>" }`. Show `error` directly in the UI.

| Status | Meaning |
|---|---|
| 400 | validation failed / missing device id / wrong OTP / deadline passed |
| 401 | missing or invalid `X-API-Key` |
| 403 | not eligible (scheme land cap) |
| 404 | unknown id (or not yours, for device-scoped data) |
| 409 | action not allowed in the current state (e.g. verify OTP on a pending order) |
| 413 | image over 8 MB / body too large |
| 422 | uploaded file is not a readable image |
| 429 | rate limited |
| 502 | weather provider down |
| 500 | unexpected server error |

### Rate limits (per client IP)

300 requests/min overall - 20 soil scans/min - 10 OTP attempts per 15 min.

---

## 2. Health

### `GET /health`
No auth. `200 {"status":"ok","uptime":123.4}`

---

## 3. Soil health (snake_case - unchanged contract)

### `POST /v1/analyze`
This server **analyses the photo itself** (a colour-based heuristic run in-process; no separate analyzer service), stores the result in this device's history, and returns it.

`multipart/form-data`:

| Field | Type | Notes |
|---|---|---|
| `image` | file | max 8 MB; JPEG, PNG, WebP or GIF. The real type is detected from the file bytes, so Flutter's default `application/octet-stream` upload works unchanged |
| `metadata_json` | text | JSON string: `{"device_id":"<id>","crop_type":"tomato"}` - `device_id` required, `crop_type` (the plant type) optional, <= 50 chars |

Alternatives that also work: send `device_id` and `crop_type` (or `plant_type`) as plain form fields, and/or the device id in the `X-Device-Id` header. `metadata_json` wins if both are present.

`200`:
```json
{
  "id": "9b2c...-uuid",
  "created_at": "2026-09-20T09:15:00.000Z",
  "health_score": 71.4,
  "soil_moisture": 52.3,
  "nutrient_n": 38.2,
  "nutrient_p": 66.0,
  "nutrient_k": 74.5,
  "disease": "No significant disease indicators",
  "disease_confidence": 88.0,
  "recommendations": [
    "Nitrogen is low - apply vermicompost or neem cake before the next watering."
  ],
  "metadata": { "device_id": "abc123", "crop_type": "tomato" }
}
```
- All scores are 0-100. `recommendations` always has at least one entry; the first is the most important (used for the home-card note).
- `metadata.crop_type` is omitted when none was sent (your parser already treats it as nullable).
- `created_at` is always an explicit UTC ISO string ending in `Z`, so `DateTime.parse(...).toLocal()` shows the right local time.
- Errors: `400` (no image, missing device id, bad metadata, or the file is not JPEG/PNG/WebP/GIF), `413` (too large), `422` (the file looks like an image but cannot be decoded). A failed scan is never stored.
- This is exactly what `SoilHealthApiDataSource._parseResult` already reads.

### `GET /v1/history?device_id=<id>`
`200`: array of the objects above - **up to 5 scans from the last 15 days, newest first**. `[]` when none. (The `X-Device-Id` header works too.)

### `GET /v1/scan/:id`
Device required. `200` one scan object; `404` if the id isn't in this device's recent history. Lets `getScanById` stop scanning the history list.

---

## 4. Weather

### `GET /v1/weather?lat=<-90..90>&lon=<-180..180>`
No device id. `200`:
```json
{
  "location": "Sirur, Maharashtra",
  "days": [
    { "date": "2026-09-20", "condition": "rainy", "tempHighC": 31.1, "tempLowC": 22.8, "rainChancePercent": 92 }
  ]
}
```
- `days[0]` is today, 5 days total. Same shape as `WeatherForecast` / `WeatherDay`.
- `location` falls back to `"18.83, 74.38"` if reverse geocoding fails.
- Cached server-side for 10 minutes per ~1 km cell. Errors: `400` bad coordinates, `502` provider down.
- The app still gets GPS via `Geolocator`; only the two direct Open-Meteo/BigDataCloud calls move to this endpoint.

---

## 5. Farmer home (device)

### `GET /v1/farmer/profile`
`200`:
```json
{ "name": "Pratik Kolhe", "village": "Shirur, Pune", "unreadNotificationCount": 2, "landHoldingHectares": 1.5 }
```
`unreadNotificationCount` is read-only: it is the number of unread notifications (see below). A device that never saved a profile gets defaults: `{"name":"Farmer","village":"","unreadNotificationCount":0,"landHoldingHectares":0}`.

### `PUT /v1/farmer/profile`
Body - every field optional, send only what changes:
```json
{ "name": "Pratik Kolhe", "village": "Shirur, Pune", "landHoldingHectares": 1.5 }
```
`200` returns the full profile. Limits: name <= 80, village <= 120, land 0-10000. Errors: `400`.

### `GET /v1/farmer/recommendation`
`200` - matches `SmartRecommendation`:
```json
{
  "category": "nutrient",
  "title": "Time to boost Nitrogen",
  "description": "Your last soil scan showed nitrogen is your weakest nutrient. Try vermicompost or neem cake before the next watering.",
  "actionLabel": "View soil report"
}
```
Chosen from the device's latest scan, in priority order: dry soil (`water`) -> likely disease (`pest`) -> weakest nutrient below 70 (`nutrient`) -> all good (`harvest`). With **no scan yet** it returns `category: "nutrient"`, `actionLabel: "Scan soil"` - route that button to the scan screen instead of the report.

### Notifications (device)

The bell on the home screen. Notifications are created by the server when something happens; the app never creates them.

| Event | `type` | `title` | `refId` |
|---|---|---|---|
| A soil scan finishes | `scan` | Soil scan complete | the scan id (deep-link to the result) |
| A scheme application is submitted | `scheme` | Application submitted | the scheme id |
| The farmer places an order | `order` | Order placed | the order id |
| The village center marks it ready | `order` | Your order is ready for pickup | the order id |
| The pickup OTP is verified | `order` | Order collected | the order id |
| The village center cancels it | `order` | Your order was cancelled | the order id |

`Notification`:
```json
{
  "id": "notif-3f2c...",
  "type": "scan",
  "title": "Soil scan complete",
  "body": "Your soil health score is 71/100. Tap to see the full report.",
  "refId": "9b2c...-uuid",
  "createdAt": "2026-09-20T16:04:24.000Z",
  "read": false
}
```
`type` is one of `scan`, `scheme`, `order`. Order notifications carry the pickup code in the body (it is the farmer's own code).

| Endpoint | Notes |
|---|---|
| `GET /v1/farmer/notifications` | newest first; `?unread=true` for unread only; last 100 are kept per device |
| `POST /v1/farmer/notifications/:id/read` | `200` the updated notification; `404` if it isn't this device's |
| `POST /v1/farmer/notifications/read-all` | `200 {"unreadCount":0}` |

The `unreadNotificationCount` in the profile is always the real number of unread notifications, so the badge clears after `read` / `read-all` (re-fetch the profile).

---

## 6. Marketplace

### `GET /v1/products`
Optional filters: `category` (enum), `nutrient` (`nitrogen|phosphorus|potassium`, matches `nutrientFocus`), `q` (searches name/brand/description). `200` array of `Product`:
```json
{
  "id": "p-neemcake",
  "name": "Neem Cake",
  "brand": "KisanShield",
  "category": "organic",
  "priceInRupees": 600,
  "unitLabel": "25 kg bag",
  "rating": 4.1,
  "reviewCount": 58,
  "description": "Organic soil conditioner ...",
  "nutrientFocus": ["nitrogen"],
  "npkPercentages": { "nitrogen": 2 }
}
```
- `npkPercentages` is an object keyed by nutrient name; keys are absent for nutrients the product doesn't provide (empty `{}` for seeds/equipment). Parse with `NutrientType.values.byName(key)`.
- Errors: `400` invalid `category`/`nutrient`.

### `GET /v1/products/:id`
`200` one `Product`; `404`.

### `GET /v1/products/:id/reviews`
`200` array, newest first:
```json
{ "id": "p-neemcake-review-0", "productId": "p-neemcake", "authorName": "Anita K.", "rating": 4, "comment": "Good results ...", "date": "2026-09-15T..." }
```
`productId` is extra; `ProductReview` can ignore it.

### `POST /v1/products/:id/reviews` (new - no UI yet)
Body `{ "authorName": "Ravi", "rating": 5, "comment": "Great" }` (rating integer 1-5, comment <= 1000). `201` returns the review; the product's `rating`/`reviewCount` update automatically.

### Farmer orders (new - the app has no checkout yet)
These create the `appOrder`s the operator app sees.

**`POST /v1/orders`** (device)
```json
{ "customerName": "Pratik Kolhe", "items": [ { "productId": "p-vermicompost", "quantity": 2 } ] }
```
- `customerName` optional (defaults to the profile name, then `"Farmer"`). 1-50 items, quantity 1-100.
- **Prices are taken from the catalog** - never send a price.
- `201`: an `Order` (see section 9) with `status: "pending"` and a 4-digit **`pickupOtp`** - show it to the farmer to read out at the counter.
- Errors: `400`, `404` unknown `productId`.

**`GET /v1/orders`** (device) - this device's orders, newest first (include `pickupOtp` while active).
**`GET /v1/orders/:id`** (device) - `404` if it belongs to another device.
**`POST /v1/orders/:id/cancel`** (device) - only `pending`/`readyForPickup`; else `409`.

---

## 7. Community

Farmers post questions or success stories, other farmers and agronomists answer, and an AI-generated draft answer can be verified (and edited) by a verified agronomist. `farmerId` throughout is the caller's identity — the Supabase user id, or the device id when authentication is off (same as every other farmer-owned resource) — never something the client names in the body.

`CommunityPost`:
```json
{
  "postId": "post-1", "farmerId": "a1b2...", "farmerName": "Ramesh Patil",
  "title": "Yellowing leaves on wheat - nitrogen deficiency?", "content": "...",
  "cropTag": "Wheat", "districtTag": "Pune", "problemTypeTag": "nutrientDeficiency",
  "createdAt": "2026-09-18T...", "updatedAt": "2026-09-18T...",
  "commentCount": 4, "likeCount": 12
}
```
`farmerName` is looked up from the farmer's saved profile (`PUT /v1/farmer/profile`), falling back to `"Farmer"` when none was saved. `commentCount`/`likeCount` are computed from the real rows, not maintained counters.

`PostComment`:
```json
{
  "commentId": "comment-1", "postId": "post-1", "farmerId": "a1b2...", "farmerName": "Ramesh Patil",
  "content": "...", "isAiGenerated": false, "isAgronomistVerified": false,
  "agronomistId": null, "agronomistName": null, "createdAt": "2026-09-18T..."
}
```
- An ordinary farmer comment: `isAiGenerated: false`, `agronomistId: null`.
- An agronomist answering directly (`POST .../comments` with `agronomistId`): stored as `isAgronomistVerified: true` immediately — an agronomist's own words don't need separate sign-off. `farmerName` also resolves to the agronomist's name in this case (there is no profile row for an agronomist id).
- An AI-generated draft: `isAiGenerated: true`, `isAgronomistVerified: false` until `PATCH .../verify` attaches a verified agronomist to it. **Every new post gets exactly one of these automatically** — see below.

### AI draft answers

Every `POST /v1/community/posts` inserts a draft AI answer as the post's first comment, in the same transaction as the post itself (`farmerId: "ai-assistant"`, `isAiGenerated: true`, `isAgronomistVerified: false`). The draft's text always ends with a plain-language disclaimer that it is unreviewed. Generation is a placeholder (`src/services/aiAnswerService.js`, a pure `generateDraftAnswer({...}) -> string` with no DB or network access) — swapping in a real model later only changes what's inside that function.

An agronomist can clean up the wording before verifying it:

| Endpoint | Notes |
|---|---|
| `GET /v1/community/posts` | newest first. Filters: `crop`, `district` (case-insensitive exact), `problemType` (enum), `q` (title/content search). Paginated (`limit`/`offset`, `X-Total-Count`) |
| `POST /v1/community/posts` | body `{title(5-150), content(5-3000), cropTag?, districtTag?, problemTypeTag}` -> `201` post. `farmerId` is the caller. Also inserts the AI draft comment |
| `GET /v1/community/posts/:id` | one post with `likedByMe` (whether the caller has liked it) and all its comments (oldest first) as `comments: [...]`; `404` |
| `POST /v1/community/posts/:id/comments` | body `{content(2-3000), agronomistId?}` -> `201` comment. `agronomistId`, if given, must be a verified agronomist (`404`/`403`) |
| `PATCH /v1/community/comments/:id` | body `{agronomistId, content}` -> `200` comment with the new wording. Does **not** verify it. `409` if the comment isn't AI-generated, `404`/`403` for an unverified/unknown agronomist |
| `PATCH /v1/community/comments/:id/verify` | body `{agronomistId}` (must be verified) -> `200` comment with `isAgronomistVerified: true`. `409` if the comment isn't AI-generated |
| `POST /v1/community/posts/:id/like` | **toggle** — likes if not already liked, unlikes if it is. `200 {"liked": bool, "likeCount": n}` |

`Agronomist`: `{agronomistId, name, verifiedStatus, specialization}` — no endpoints yet; verified status is set directly in the database for now.

---

## 8. Government schemes

`GovScheme`:
```json
{
  "id": "scheme-pkvy", "name": "Paramparagat Krishi Vikas Yojana",
  "agency": "Ministry of Agriculture & Farmers Welfare", "category": "subsidy",
  "description": "...", "benefit": "...",
  "eligibilityCriteria": ["Land holding up to 2 hectares", "..."],
  "maxLandHoldingHectares": 2.0,
  "applicationDeadline": null
}
```
`maxLandHoldingHectares` and `applicationDeadline` are `null` when there is no cap / no deadline.

| Endpoint | Notes |
|---|---|
| `GET /v1/schemes` | all 5 schemes |
| `GET /v1/schemes/:id` | one scheme; `404` |
| `GET /v1/schemes/applications` | device. All of this device's applications |
| `GET /v1/schemes/:id/application` | device. `{"schemeId","status","appliedDate"}`; when never applied: `status:"notApplied"`, `appliedDate:null` |
| `POST /v1/schemes/:id/apply` | device. First apply -> `201` with `status:"submitted"`; already applied (and not rejected) -> `200` unchanged; a rejected one can be re-applied |

Apply errors: `400` deadline passed, `403` land cap exceeded (checked only if the device saved a profile via `PUT /v1/farmer/profile`), `404`.
`SchemeEligibility.isEligible` can stay client-side for showing the badge; the server enforces it again on apply.
`submitted -> underReview -> approved/rejected` transitions are made by the authority side, not by the app.

---

## 9. Operator (village center) - `/v1/operator/...`

No device id. Single shared dataset.

### Farmers
- `GET /v1/operator/farmers` - filters `needsFollowUp=true|false`, `q` (name/village/crop).
- `GET /v1/operator/farmers/:id` - `404` if unknown.

`Farmer`:
```json
{ "id": "farmer-ramesh", "name": "Ramesh Patil", "village": "Shirur, Pune", "phone": "+91 98221 XXXXX",
  "activeCrop": "Wheat", "lastVisitDate": "2026-09-16T...", "needsFollowUp": false, "notes": "..." }
```

### Orders

`Order` (returned by all order endpoints):
```json
{
  "id": "order-1",
  "customerName": "Ramesh Patil",
  "type": "appOrder",
  "status": "pending",
  "items": [ { "productName": "Neem Cake", "quantity": 2, "unitPrice": 600 } ],
  "createdAt": "2026-09-20T07:00:00.000Z",
  "pickupOtp": null,
  "totalAmount": 1200,
  "itemCount": 2
}
```
- **`pickupOtp` is always `null` on operator endpoints.** The operator types the code the farmer reads out and the server checks it. Remove any client-side OTP comparison.
- `totalAmount` / `itemCount` are extras (your entity computes them itself; ignoring them is fine).

| Endpoint | Notes |
|---|---|
| `GET /v1/operator/orders` | newest first. Filters: `status`, `type` (enums; `400` if invalid) |
| `GET /v1/operator/orders/:id` | `404` |
| `POST /v1/operator/orders/:id/ready` | `pending -> readyForPickup`. Already ready -> `200` unchanged. Completed/cancelled -> `409` |
| `POST /v1/operator/orders/:id/verify-otp` | body `{"otp":"4821"}` (exactly 4 chars). Order must be `readyForPickup` (else `409`). Wrong code -> `400 {"error":"Incorrect OTP - please check with the farmer and try again."}`. Success -> `200`, order `completed` |
| `POST /v1/operator/orders/:id/cancel` | pending/ready only, else `409` |
| `POST /v1/operator/orders/walk-in` | body `{"customerName":"Sita","items":[{"productName":"Neem Cake","quantity":2,"unitPrice":600}]}`. `customerName` optional (default `"Walk-in customer"`). Creates an already-`completed` `walkIn` order -> `201` |

Seed state: 6 orders (`order-1`..`order-6`) as in the old fake data; seeded OTPs (`4821`, `7093`, `2246`) are not exposed by the operator API.

### Inventory
- `GET /v1/operator/inventory/items` -> `InventoryItem` + extra `isLowStock`:
  `{ "id":"inv-neemcake","name":"Neem Cake","unit":"bag","unitPrice":600,"currentStock":5,"lowStockThreshold":8,"isLowStock":true }`
- `GET /v1/operator/inventory/restock-requests` -> newest first:
  `{ "id":"restock-1","itemId":"inv-neemcake","itemName":"Neem Cake","requestedQuantity":30,"status":"approved","requestedDate":"..." }`
- `POST /v1/operator/inventory/restock-requests` body `{"itemId":"inv-neemcake","quantity":20}` -> `201` request with `status:"pending"`. `404` unknown item, `400` quantity not an integer 1-100000.

Stock levels are not decremented by orders yet (same as the app today).

### Earnings
- `GET /v1/operator/earnings/commission-rate` -> `{"commissionRatePercent":5}`
- `GET /v1/operator/earnings/summary` -> `{"commissionRatePercent":5,"todaySales":0,"monthSales":2670,"todayCommission":0,"monthCommission":133.5}` - completed orders only; day/month use the **server's** local time. Optional: the screen may keep computing from the orders list as it does now.

---

## 10. Frontend change checklist

| Flutter piece | Replace with |
|---|---|
| `ApiConfig.soilSenseBaseUrl` | point `API_BASE_URL` at the server; add `X-Device-Id` (and `X-API-Key`) to every request - simplest via one shared `http.Client` wrapper |
| `SoilHealthApiDataSource` | already matches - only the base URL changes. `getScanById` can call `GET /v1/scan/:id` |
| `WeatherApiDataSource` | keep `Geolocator`; call `GET /v1/weather?lat&lon`; drop the Open-Meteo/BigDataCloud code |
| `FarmerFakeDataSource` | `GET /v1/farmer/profile` (+ `PUT` from a profile-edit screen) |
| `RecommendationFakeDataSource` | `GET /v1/farmer/recommendation` |
| `MarketplaceFakeDataSource` | `GET /v1/products`, `/products/:id`, `/products/:id/reviews` |
| `CommunityApiDataSource` | rebuild against the new shape: `GET/POST /v1/community/posts`, `GET /posts/:id` (now includes `comments`), `POST /posts/:id/comments`, `PATCH /comments/:id/verify`, `POST /posts/:id/like` (now a toggle) |
| `SchemesLocalDataSource` | `GET /v1/schemes`, `/schemes/:id`, `/schemes/:id/application`, `POST /schemes/:id/apply` |
| `FarmersFakeDataSource` | `GET /v1/operator/farmers`, `/farmers/:id` |
| `InventoryLocalDataSource` | `GET /v1/operator/inventory/items`, `/restock-requests`, `POST /restock-requests` |
| `OrdersLocalDataSource` | `GET /v1/operator/orders`, `/orders/:id`, `POST .../ready`, `.../verify-otp`, `/orders/walk-in` |
| `EarningsFakeDataSource` | `GET /v1/operator/earnings/commission-rate` |

Tips:
1. Wrap non-2xx responses as `throw Exception(jsonDecode(body)['error'])` so the existing error UIs show the server message (the OTP screen already expects a message like this).
2. The Drift tables for orders, restock requests and scheme applications become an offline cache/queue only; the server is now the source of truth. Since the village-center app is offline-first, decide later whether to queue writes locally and sync when online (the server has no sync/conflict endpoint yet).
3. **New capabilities with no UI yet:** placing an order (`POST /v1/orders`), farmer order list/cancel, posting reviews/posts/replies, likes, profile editing, scheme applications list, `/earnings/summary`.
