# server_khaadsetu

Express API for the KHAAD Setu Flutter app (farmer app + village-center/operator app).

```bash
npm install
cp .env.example .env
npm run dev      # http://localhost:3000
npm test
```

Requires Node 20+. Data is persisted to `DATA_FILE` (default `./data/db.json`) and seeded on first run with the same starter data the app used to fake locally.

## Conventions

- All endpoints live under `/v1` (plus unauthenticated `GET /health`).
- JSON in and out. Field names and enum values match the Flutter entities (`camelCase`, enums as their `.name`, e.g. `readyForPickup`). The **soil** endpoints keep the original Soil Sense `snake_case` contract.
- Errors: `{ "error": "message" }` with a meaningful status (400 validation, 401 key, 404, 409 wrong state, 413/422 bad upload, 429 rate limit).
- Lists return a plain JSON array, with `X-Total-Count` and optional `?limit=&offset=`.
- Farmer data is scoped per device: send `X-Device-Id: <id>` (or `?device_id=`). The operator API is global to the village center.
- If `API_KEY` is set, every `/v1` call needs `X-API-Key`.

## Endpoints

### Soil health
| Method | Path | Notes |
|---|---|---|
| POST | `/v1/analyze` | multipart: `image` (file, max 8 MB) + `metadata_json` (`{"device_id","crop_type?"}`) |
| GET | `/v1/history?device_id=` | up to 5 scans from the last 15 days, newest first |
| GET | `/v1/scan/:id` | one scan (device-scoped) |

The analyzer (`src/services/soilAnalyzer.js`) is a placeholder colour-statistics heuristic. Swap in the ML model there; keep the returned shape.

### Weather
`GET /v1/weather?lat=&lon=` — 5-day forecast + place name (Open-Meteo / BigDataCloud, cached 10 min).

### Farmer home
| Method | Path | Notes |
|---|---|---|
| GET / PUT | `/v1/farmer/profile` | `name, village, landHoldingHectares, unreadNotificationCount` |
| GET | `/v1/farmer/recommendation` | smart card derived from the latest scan |

### Marketplace
| Method | Path | Notes |
|---|---|---|
| GET | `/v1/products` | filters: `category`, `nutrient`, `q` |
| GET | `/v1/products/:id` | |
| GET / POST | `/v1/products/:id/reviews` | POST `{authorName, rating 1-5, comment}` |
| POST | `/v1/orders` | `{customerName?, items:[{productId, quantity}]}` — prices come from the catalog; returns the pickup OTP |
| GET | `/v1/orders`, `/v1/orders/:id` | the device's own orders (includes OTP) |
| POST | `/v1/orders/:id/cancel` | pending / ready orders only |

### Community
| Method | Path | Notes |
|---|---|---|
| GET | `/v1/community/posts` | filters: `crop`, `district`, `problemType`, `q` |
| POST | `/v1/community/posts` | `{authorName,title,body,crop,district,problemType}` |
| GET | `/v1/community/posts/:id`, `/:id/replies` | |
| POST | `/v1/community/posts/:id/replies` | `{authorName, body}` |
| POST / DELETE | `/v1/community/posts/:id/like` | one like per device, idempotent |

### Government schemes
| Method | Path | Notes |
|---|---|---|
| GET | `/v1/schemes`, `/v1/schemes/:id` | |
| GET | `/v1/schemes/applications` | all of the device's applications |
| GET | `/v1/schemes/:id/application` | `notApplied` when none |
| POST | `/v1/schemes/:id/apply` | idempotent; enforces deadline and land cap (when a profile exists) |

### Operator (village center) — `/v1/operator`
| Method | Path | Notes |
|---|---|---|
| GET | `/farmers`, `/farmers/:id` | filters: `needsFollowUp`, `q` |
| GET | `/orders`, `/orders/:id` | filters: `status`, `type`. The OTP is never returned here |
| POST | `/orders/walk-in` | `{customerName?, items:[{productName, quantity, unitPrice}]}` |
| POST | `/orders/:id/ready` | pending → readyForPickup |
| POST | `/orders/:id/verify-otp` | `{otp}` — verified server-side, rate limited; readyForPickup → completed |
| POST | `/orders/:id/cancel` | |
| GET | `/inventory/items` | includes `isLowStock` |
| GET / POST | `/inventory/restock-requests` | POST `{itemId, quantity}` |
| GET | `/earnings/commission-rate`, `/earnings/summary` | commission on completed orders |

## Deploying on EC2

- Install Node 20+: `sudo dnf install -y nodejs20`.
- Set `PORT`, `API_KEY` and `DATA_FILE` (e.g. `/var/lib/khaadsetu/db.json`, owned by `ec2-user`) as `Environment=` lines in the systemd unit.
- **Nginx must allow photo uploads** — its default body limit is 1 MB. Add `client_max_body_size 10m;` inside the `server { }` block.
- The JSON store is single-process. Run one instance; move to Postgres/DynamoDB behind `src/db/store.js` before scaling out.

## Not built yet

There is no farmer/operator login: farmers are identified by device id and the operator API is protected only by the shared `API_KEY`. Add real auth (e.g. phone-OTP login) before exposing this publicly with real user data.
