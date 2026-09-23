# server_khaadsetu

Express API for the KHAAD Setu Flutter app (farmer app + village-center/operator app).

```bash
npm install
cp .env.example .env     # then set DATABASE_URL to your Postgres
npm run dev              # http://localhost:3000 (creates the tables on first start)
npm test                 # needs TEST_DATABASE_URL, see below
```

Requires Node 20+ and PostgreSQL 13+.

## Database

Data lives in PostgreSQL (`DATABASE_URL`; add `DATABASE_SSL=true` for managed hosts that need TLS, RDS included). `DATABASE_URL` must be the full connection string — `postgres://<user>:<password>@<host>:<port>/<database>` — not just the RDS endpoint by itself.

A fresh RDS instance only has its built-in `postgres` maintenance database; it does not have `khaadsetu` (or whatever you name yours) until something creates it. On every start, the server first opens a *separate* connection to that maintenance database (`DATABASE_BOOTSTRAP_DB`, default `postgres`) to check whether `DATABASE_URL`'s database exists yet and creates it there if not — this is unavoidable in Postgres, which has no `CREATE DATABASE IF NOT EXISTS` and no way to switch databases on one connection (see `src/db/bootstrap.js`). Once the database exists, the schema is plain SQL in `migrations/`, applied in filename order on every start (or on demand with `npm run migrate`); applied files are recorded in `schema_migrations`, and concurrent instances are serialised with an advisory lock. An empty database is seeded once with the starter data. To change the schema, add a new numbered file (`002_….sql`) — never edit one that has been applied.

Farmer-side rows (`profiles`, `scans`, `orders`, `notifications`, `scheme_applications`, `post_likes`) carry an `owner_id`: the Supabase user id, or the anonymous device id when authentication is off. It is deliberately not a foreign key; accounts live in Supabase.

Tests run against a real Postgres. Point `TEST_DATABASE_URL` at a throwaway database (default `postgres://postgres@localhost:5432/khaad_test`); each test file creates and drops its own schema inside it.

## Conventions

- All endpoints live under `/v1` (plus unauthenticated `GET /health`).
- JSON in and out. Field names and enum values match the Flutter entities (`camelCase`, enums as their `.name`, e.g. `readyForPickup`). The **soil** endpoints keep the original Soil Sense `snake_case` contract.
- Errors: `{ "error": "message" }` with a meaningful status (400 validation, 401 key, 404, 409 wrong state, 413/422 bad upload, 429 rate limit).
- Lists return a plain JSON array, with `X-Total-Count` and optional `?limit=&offset=`.
- Farmer data is scoped per device: send `X-Device-Id: <id>` (or `?device_id=`). The operator API is global to the village center.
- Auth: set `SUPABASE_URL` and every `/v1` call needs `Authorization: Bearer <Supabase access token>`; data is then owned by the token's user id (see `API.md`). Unset = anonymous `X-Device-Id` mode for local development.
- If `API_KEY` is set, every `/v1` call needs `X-API-Key`.

## Endpoints

### Soil health
| Method | Path | Notes |
|---|---|---|
| POST | `/v1/analyze` | multipart: `image` (file, max 8 MB) + `metadata_json` (`{"device_id","crop_type?"}`) |
| GET | `/v1/history?device_id=` | up to 5 scans from the last 15 days, newest first |
| GET | `/v1/scan/:id` | one scan (device-scoped) |

Photos are analysed in-process by `src/services/soilAnalyzer.js` (decoded with [`sharp`](https://sharp.pixelplumbing.com/), scored by a colour heuristic; no separate Python service). Results are stored here, so history, scan-by-id and the home recommendation work off this server.

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
| GET | `/v1/community/posts` | filters: `crop`, `district`, `problemType`, `q`; paginated |
| POST | `/v1/community/posts` | `{title, content, cropTag?, districtTag?, problemTypeTag}` |
| GET | `/v1/community/posts/:id` | post + all its comments |
| POST | `/v1/community/posts/:id/comments` | `{content, agronomistId?}` — farmer, or an agronomist answering directly |
| PATCH | `/v1/community/comments/:id` | `{agronomistId, content}` — agronomist edits an AI draft's wording before verifying it |
| PATCH | `/v1/community/comments/:id/verify` | `{agronomistId}` — attaches agronomist sign-off to an AI-generated comment |

Every new post also gets a draft AI answer as its first comment automatically (`src/services/aiAnswerService.js` — a placeholder today, isolated so a real model can be plugged in later without touching anything else).
| POST | `/v1/community/posts/:id/like` | toggle — likes if not liked, unlikes if it is |

See `API.md` for the full request/response shapes.

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
- Set `PORT`, `API_KEY`, `DATABASE_URL` (+ `DATABASE_SSL=true` for RDS) and `SUPABASE_URL` as `Environment=` lines in the systemd unit. Keep the database password out of the repo.
- **Nginx must allow photo uploads** — its default body limit is 1 MB. Add `client_max_body_size 10m;` inside the `server { }` block.
- State lives in Postgres, so several instances can run behind the load balancer. Migrations take an advisory lock, so they are safe to run on every instance's start.

## Not built yet

Farmers sign in through Supabase (see `API.md`), but there are no farmer/operator roles yet: any signed-in user can call the operator API. Add roles before exposing the operator endpoints publicly with real data.
