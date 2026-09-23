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
- Roles are enforced by the server: `/v1/operator/*` needs the caller to own a village center, `/v1/admin/*` needs an email listed in `SUPER_ADMIN_EMAILS`. The role picked at sign-up is only a request, never authority (see section 9).

### Headers

| Header | When | Notes |
|---|---|---|
| `Content-Type: application/json` | every request with a JSON body | not needed for the multipart soil upload |
| `X-Device-Id: <string>` | every **farmer-side** call marked "device" below, **only when authentication is off** | your existing `deviceIdProvider` value. Alternative: `?device_id=<id>` query param. Missing -> `400` |
| `X-API-Key: <string>` | every `/v1` call, **only if** the server has `API_KEY` set | missing/wrong -> `401` |

Operator endpoints (`/v1/operator/*`) act on the caller's own village center; the caller is identified like any other user (token, or device id when auth is off).

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
`type` is one of `scan`, `scheme`, `order`, and for accounts that get them: `stock` (an operator's low-stock alert, or a reviewed delivery report), `restock` (a restock approved/delivered), `account` (suspended/reactivated). Clients should treat an unknown type as generic rather than failing. Order notifications carry the pickup code in the body (it is the farmer's own code).

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

### Farmer orders
These create the `appOrder`s the operator app sees. **Placing an order holds the stock** at the assigned center.

**`POST /v1/orders`** (device)
```json
{ "customerName": "Pratik Kolhe", "items": [ { "productId": "p-vermicompost", "quantity": 2 } ],
  "latitude": 18.83, "longitude": 74.37, "locationSource": "gps", "centerId": "center-..." }
```
- `customerName` optional (defaults to the profile name, then `"Farmer"`). 1-50 items, quantity 1-100. **Prices are taken from the catalog** - never send a price.
- **Which center.** With `centerId` the farmer's own choice is used. Without it the best-ranked center (section 9, "Finding a center") that has **every item** is assigned, from the location in the body (`latitude`+`longitude`, or `village`), else the saved profile location. Neither a center nor a location -> `400`.
- **Stock is held atomically.** `available = on hand - reserved`. If two farmers race for the last unit, exactly one wins: an automatic assignment quietly falls through to the next-ranked center; an explicit `centerId` that ran dry returns `409`.
- `201`: an `Order` with `status:"pending"`, a 4-digit **`pickupOtp`**, `centerId`, **`reservedUntil`** (the pickup deadline: 5 days) and `center:{centerId,name,village,phone}`. The farmer gets an in-app notification, and so does the center's operator ("New app order").
- `409` `{ "error": "...", "code": "out_of_stock", "alternatives": [{centerId,name,village,distanceKm,inventoryStatus,inventoryLabel}] }` - offer these to the farmer. "That center just went out of stock..." for an explicit center, "None of the centers near you have all of these items right now." otherwise.
- Other errors: `400`, `404` unknown `productId` / center.
- **Orders do not get stranded.** A background pass (every 10 minutes, `src/services/reassignment.js`) moves a still-`pending` order (one the operator has not confirmed) off a center that cannot serve it, to the next-best center that has **every item**, taking the reserved stock with it. A center cannot serve when it is closed by its operator, suspended (or its operator is), or **offline**: no operator API request for 12 hours *during its opening hours* (silence overnight is normal). An order must have waited 30 minutes first, so a short break does not shuffle orders; it moves at most twice; its pickup code and deadline do not change. The farmer, the old operator and the new operator are notified (`order` notifications, `refId` = the order). If no other center has everything, the order stays and is tried again on the next pass.
- **Reservation lifecycle.** Collected (operator verifies the OTP): goods leave the shelf (on hand and reserved both drop) and, if the farmer has no home center yet, this center becomes it. Cancelled by farmer or operator: stock is released. **Not collected within 5 days: the order is cancelled automatically and the stock released.** Reminders arrive as notifications when day 3 and day 5 of the reservation begin (the order day is day 1). A background job runs every 10 minutes (`src/services/reservationJobs.js`).

**Buying surplus.** A line can be `{ "surplusLotId": "lot-...", "quantity": 2 }` instead of a `productId` (see "Surplus near me" in section 9). The product and **price come from the lot**, never the client. It is held with the same guarded update as shelf stock, so the last units go to exactly one farmer. A surplus lot exists only at the center that listed it, so the order goes there: a `centerId` for another center, or lots from two centers in one cart, is `400`. Regular lines in the same cart must be available at that center too, and if the lot has just sold out the whole order fails (`409` `{code:"surplus_unavailable", surplusLotId}`) without holding anything. Each item in an order carries `surplusLotId` (`null` for regular lines). Cancel and expiry give surplus units back to the lot; collecting takes them out for good. Orders holding surplus are **not** moved by reassignment.

**"Notify me when available"** (device): `GET /v1/products/:id/notify-me` -> `{subscribed}`; `PUT` `{latitude,longitude}` (or a `village`, or the saved profile location) subscribes from that place (`400` with no location, `404` unknown product; repeating is fine); `DELETE` unsubscribes. When **any center within 35 km** of that place receives the product, the farmer gets one `stock` notification ("Neem Cake is back in stock", `refId` = the product) and the subscription ends.

**`GET /v1/orders`** (device) - this device's orders, newest first (include `pickupOtp` while active). Every farmer-side order view (list, detail, place, cancel) carries `center:{centerId,name,village,phone}` (or `null` for orders from before centers existed).
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

## 9. Roles, centers and admin

**Who is what** (decided by the server, never by client-editable metadata):
- **admin** - the verified token's email is in `SUPER_ADMIN_EMAILS` (comma-separated). With authentication off (local dev) admin routes are open.
- **operator** - the user owns a village center (assigned by an admin). One operator, one center.
- **farmer** - everyone else. A user who *asked* to be an operator at sign-up but has no center yet is a farmer with `requestedRole:"operator"`.

### `GET /v1/me`
Call after sign-in. Records the account and returns `{userId, email, name, requestedRole, status, role:"admin"|"operator"|"farmer", center:{centerId,name,status}|null}`.

### Admin panel API - `/v1/admin/...`
Everything here needs an administrator (`403` otherwise), and every change is written to the audit log in the same transaction (a failed change leaves no entry).

**Overview** - `GET /overview` -> `{people:{operators:{active,suspended,unassigned,total}, farmers:{active,suspended,total}}, centers:{active,suspended,withoutOperator,total}, orders:{pending,readyForPickup,today}, restockRequests:{pending}, lowStockItems, lowStockUnattended, discrepanciesOpen}`. `lowStockUnattended` counts products still low a full day after the operator was alerted (nobody has acted); `discrepanciesOpen` counts unreviewed delivery reports.

**People, categorised.** Everyone who has signed in is a `role` (`operator` = owns a center or asked to be one; `farmer`) in a `segment`: `active`, `suspended` (the account, or for an operator their center, is suspended) or `unassigned` (an operator with no center yet). Administrators (`SUPER_ADMIN_EMAILS`) are not listed.
- `GET /users/summary` -> `{operators:{active,suspended,unassigned,total}, farmers:{active,suspended,total}}`.
- `GET /users` - filters `role`, `segment`, `q` (name/email/village); paged. Row: `userId, email, name, status, requestedRole, role, segment, centerId, centerName, centerStatus, village, landHoldingHectares, ordersCount, createdAt, lastSeenAt`.
- `GET /users/:id` - the row plus `profile:{latitude,longitude,locationSource,homeCenterId}` and `activity:{scans, orders:{status:count}}`. `404` for unknown people and administrators.
- `PATCH /users/:id` - `{status:"suspended"|"active", reason?}`. A suspended person gets `403 {code:"account_suspended"}` on every call except `GET /me` (so the app can explain), immediately; the person is notified. A suspended operator's center stops being offered to farmers and cannot take orders. You cannot change your own account (`400`); administrators are never locked out.

**Village centers.** `VillageCenter`: `centerId, name, village, district, latitude, longitude, operatorId, operatorName, phone, isOpen, opensAt "HH:MM", closesAt "HH:MM", status, createdAt`. The list and detail add `operatorEmail, operatorUserName, operatorStatus, productsStocked, lowStockCount, pendingOrders`.
- `GET /centers` - filters `status`, `district`, `hasOperator=true|false`, `q`; paged. `GET /centers/:id`.
- `POST /centers` - `{name, village, latitude, longitude, district?, phone?, operatorName?, operatorId?, opensAt?, closesAt?}` -> `201`. `operatorId` must be a user who has signed in (`404`) and not already run a center (`409`).
- `PATCH /centers/:id` - any field above except the operator; `status` suspends or reactivates (`400` if nothing to change).
- `PUT /centers/:id/operator` - `{"userId":"..."}` assigns, `{"userId":null}` unassigns (`409` if that user runs another center).
- `GET /centers/:id/inventory` - the center's shelves (same item shape as the operator's).

**Orders** - `GET /orders` across every center: filters `status`, `type`, `centerId`, `q` (customer name); each has `centerName`; pickup codes are never included.

**Restock requests (supply chain)** - `GET /restock-requests` (filters `status`, `centerId`), `PATCH /restock-requests/:id` `{status:"approved"|"fulfilled"}`. Flow is `pending -> approved -> fulfilled`; anything else is `409`. **Approving adds the quantity to the center's `incoming`**; the operator is notified; the stock itself is added when the operator confirms receipt (`POST /operator/inventory/receive`), which clears `incoming`.

**Delivery discrepancies** - `GET /discrepancies` (filter `status=open|resolved`; each has `centerName, productName, expectedQuantity, receivedQuantity, note, status, resolutionNote`), `PATCH /discrepancies/:id` `{note?}` marks it resolved (`409` if already, `404` unknown) and tells the operator. Audit action `discrepancy.resolve`.

**Audit log** - `GET /audit` (filters `targetType`, `targetId`; newest first): `{id, adminId, adminEmail, action, targetType, targetId, details, createdAt}`. Actions: `center.create|update|suspend|reactivate|assignOperator|unassignOperator`, `user.suspend|reactivate`, `restock.approved|fulfilled`.

### Finding a center (farmer) - `/v1/centers`
`POST /v1/centers/nearby` returns the best centers for a farmer, ranked by distance **and** stock, not just proximity.

Body (all optional except a way to locate the farmer):
```json
{ "latitude": 18.83, "longitude": 74.37, "locationSource": "gps",
  "village": "Shirur, Pune",
  "items": [{"productId": "p-neemcake", "quantity": 2}],
  "limit": 5, "saveToProfile": false }
```
Location is taken from the first that applies: (1) `latitude`+`longitude` (`locationSource` `gps` (default) or `pin`), (2) `village`, (3) coordinates saved on the profile, (4) the profile's registered village. None -> `400`; unknown village -> `404`. `saveToProfile:true` stores a GPS/pin fix on the profile (never a village lookup). `items` is the cart or recommendation list; same product twice is summed; unknown product -> `404`.

Response: `{location:{latitude,longitude,source}, radiusKm, centers:[...]}`. The radius is adaptive: 10 km, widened to 20 then 35 only until at least 2 centers are found. Only active centers with an operator are considered. Each entry:
- `center`: `centerId, name, village, district, latitude, longitude, operatorName, phone, rating` (`rating` is `null` until ratings exist).
- `distanceKm` (Haversine, 1 decimal), `estimatedTravelMinutes` with `travelTimeIsEstimate:true` (from distance: roads x1.3 at 30 km/h; no road data yet - show it as "~").
- `inventory`: `status` `all|partial|none` (`null` with no cart), `label` ("All items available" / "2 of 4 items available" / "Out of stock for your order"), `availableItems`, `totalItems`, and per-item `{productId, requested, available, isFullyAvailable}`. `available` = on hand minus reserved.
- `hours`: `{isOpenNow, isSwitchedOn, opensAt, closesAt, minutesUntilOpen, label}` - e.g. "Open until 18:00", "Opens tomorrow at 09:00", "Closed by operator". Judged in `CENTER_TIMEZONE` (default Asia/Kolkata).
- `pendingPickups`, `isHomeCenter`, `isRecommended` (only the first), and `recommendationReason` on the recommended one ("Closest center with all your items in stock", "2.3 km away, 3 of 4 items available", "Your home center: ...").
- `scores`: `distance, inventory, operational, historical, total` (0-100).

**Ranking.** `total = 0.40*distance + 0.35*inventory + 0.15*operational + 0.10*historical`, times 1.2 (capped at 100) for the farmer's home center. Distance: 100 within 2 km, straight down to 0 at 35 km. Inventory: average of `min(available/requested, 1)` over the cart (neutral 50 with no cart). Operational: 60 if open now (30 if switched on and opening within 12 h) plus up to 40 for a short queue (pending + ready orders, capped at 50). Historical: 50 for everyone until ratings, pickup waits and stockouts are recorded. A center with **none** of the cart is always listed after every center that has something.

**Surplus near me** - `POST /v1/centers/surplus` (device). Same location rules as `/nearby` (`latitude`+`longitude`, `village`, saved profile location). Optional `productId`, `radiusKm` (1-35, default 35) and `limit` (1-100, default 50). Returns `{location, lots:[...]}`: only lots on sale right now (active, not past best-before, with units nobody is holding, at an active center with an operator), nearest first, then deepest discount. Each lot has the fields of an operator lot (`id, productId, productName, unit, catalogPrice, unitPrice, discountPercent, available, condition, bestBefore, note, status`) plus `center:{centerId,name,village,district,phone,latitude,longitude,isOpen}`, `distanceKm`, `estimatedTravelMinutes` and `travelTimeIsEstimate`. `400` when no location can be worked out.

`GET /v1/centers/villages?q=` searches the built-in village list used for the village fallback (approximate town centres; no geocoder).

Profile (`/v1/farmer/profile`) now also carries `latitude`, `longitude`, `locationSource` (`gps|pin|village`) and `homeCenterId`. `PUT` takes latitude+longitude together (both `null` clears them) and `homeCenterId` (an active center, or `null`).

## 10. Operator (village center) - `/v1/operator/...`
All routes need the caller to own an **active** center (`403` otherwise) and only ever touch that center's data.

### My center
- `GET /v1/operator/center` -> `VillageCenter`.
- `PATCH /v1/operator/center` - `isOpen` (boolean), `opensAt`, `closesAt` (`HH:MM`), `phone`, `operatorName`. Location and status are admin-only and ignored here.


No device id. Single shared dataset.

### Farmers
The list is built from the real customers who have an app order at this center (cancelled orders don't count; walk-ins have no account): `{id (the farmer's user id), name (profile name, else the name on the order), village, phone:"", activeCrop:"", notes:"", lastVisitDate (last order), ordersCount, needsFollowUp (no order for 30 days)}`, newest first.
- `GET /v1/operator/farmers` - filters `needsFollowUp=true|false`, `q` (name/village); paged.
- `GET /v1/operator/farmers/:id` - `404` if that farmer has not ordered at this center.

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
| `POST /v1/operator/orders/walk-in` | body `{"customerName":"Sita","items":[{"productId":"p-neemcake","quantity":2,"unitPrice":600}]}`. Each line needs a catalog `productId` (older clients may send the exact catalog `productName` instead; unknown -> `400`/`404`). `customerName` optional. Creates an already-`completed` `walkIn` order -> `201` **and takes the goods off the shelf immediately, but only out of stock not reserved for app orders**: `409` ("Only 2 of Neem Cake available (3 more reserved for app orders), you asked for 3") if it would dip into reserved stock or the center doesn't stock the product. All-or-nothing across lines. |

Nothing is seeded: a new center starts with no orders, farmers or stock. Orders belong to a center (`centerId`); an operator only ever sees their own center's, and another center's order is a `404`. A farmer order may name its center with an optional `centerId` (`404` if unknown or suspended); without one it is unassigned and no operator sees it yet.

### Inventory
- Stock is per center and per product: `on_hand`, `reserved`, `reorderLevel`, `maxCapacity`, `incoming`. **`available = currentStock - reserved`** is what farmers may be promised. The database refuses `reserved > on hand` and `on hand > capacity`.
- **Low-stock alerts.** When a product's *available* stock first falls to its reorder level the operator gets one `stock` notification ("Low stock: Neem Cake", or "Out of stock: ..." at zero); it alerts again only after the product has recovered above the level (restock, cancelled order, lower/higher reorder level). Triggered by app orders, walk-in sales and reorder-level changes.
- `POST /v1/operator/inventory/receive` - `{productId, quantity, expectedQuantity?, note?}` adds stock (creates the shelf row the first time), clears the same amount from `incoming`, stamps `lastRestockedAt` -> `201` item. `404` unknown product, `409` over capacity. If `expectedQuantity` is given and differs from `quantity`, a delivery discrepancy is recorded for the supply team and the response has `discrepancy:{id,expected,received}`; the shelf always gets the `quantity` actually counted.
- `PATCH /v1/operator/inventory/items/:productId` - `{reorderLevel?, maxCapacity?}` (`maxCapacity:null` removes the limit); `404` if the center doesn't stock it, `409` if capacity < on hand.
- `GET /v1/operator/inventory/items` -> only products this center stocks. `id` is the product id; each item is the old `InventoryItem` plus `reserved`, `available`, `maxCapacity`, `incoming`, `lastRestockedAt`; `isLowStock` now means *available* <= reorder level:
  `{ "id":"inv-neemcake","name":"Neem Cake","unit":"bag","unitPrice":600,"currentStock":5,"lowStockThreshold":8,"isLowStock":true }`
- `GET /v1/operator/inventory/restock-requests` -> newest first:
  `{ "id":"restock-1","itemId":"inv-neemcake","itemName":"Neem Cake","requestedQuantity":30,"status":"approved","requestedDate":"..." }`
- `POST /v1/operator/inventory/restock-requests` body `{"itemId":"inv-neemcake","quantity":20}` -> `201` request with `status:"pending"`. `404` unknown item, `400` quantity not an integer 1-100000.

Stock levels are not decremented by orders yet (same as the app today).

### Surplus / second-hand stock

Units sold below the catalog price, kept apart from the regular shelf. Farmers find and buy them through `POST /v1/centers/surplus` and `POST /v1/orders` (section 9 / Farmer orders); `GET /v1/admin/overview` carries `surplus:{activeLots, units}`. A lot never affects reorder levels, low-stock alerts or center ranking. Scoped to the operator's own center (another center's lot is `404`).

- `GET /v1/operator/surplus` (filter `status=active|withdrawn`) -> newest first. Each lot: `id, productId, productName, unit, catalogPrice, unitPrice, discountPercent, quantity, reserved, available, condition, bestBefore ("YYYY-MM-DD" or null), note, fromShelf, createdAt, status`. `status` is `active`, `soldOut`, `expired` (best-before passed) or `withdrawn`.
- `POST /v1/operator/surplus` `{productId, quantity, unitPrice, condition, bestBefore?, note?, fromShelf?}` -> `201` lot. `condition` is `near_expiry | opened | returned | damaged_packaging | other`. `unitPrice` must be **below the catalog price** (`400`). `bestBefore` may be today but not in the past (day counted in `CENTER_TIMEZONE`). With `fromShelf: true` the units are taken off the regular shelf (only what is not reserved; else `409`); otherwise they are new units from outside the supply chain and the shelf is untouched.
- `PATCH /v1/operator/surplus/:id` `{unitPrice?, note?}` -> lot. Price must stay below the catalog price; a withdrawn lot is `409`.
- `POST /v1/operator/surplus/:id/withdraw` -> lot. Takes it off sale. Unsold units go back to the shelf if the lot was marked down from it (`409` if that would exceed the shelf's capacity, and the lot stays on sale); units held by an app order stay until that order ends.

### Earnings
- `GET /v1/operator/earnings/commission-rate` -> `{"commissionRatePercent":5}`
- `GET /v1/operator/earnings/summary` -> `{"commissionRatePercent":5,"todaySales":0,"monthSales":2670,"todayCommission":0,"monthCommission":133.5}` - completed orders only; day/month use the **server's** local time. Optional: the screen may keep computing from the orders list as it does now.

---

## 11. Frontend change checklist

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
