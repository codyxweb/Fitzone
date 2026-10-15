# FitZone | Gym Retention Management

FitZone is a TypeScript npm-workspace application for neighborhood-gym operations. The current implementation focuses on the retention loop: staff authentication, member check-ins, an inactivity scan, follow-up recording, membership plans, and verified Razorpay renewals.

## Requirements

- Node.js 22.23.3 or newer (`.nvmrc` selects the Node 24 LTS line)
- npm 9 or newer
- MongoDB (local or Atlas)

## Quick start

```sh
npm install
Copy-Item .env.example .env
npm run build --workspace=packages/shared
npm run seed
npm run dev
```

The API listens on `http://localhost:5000`; the web app is at `http://localhost:3000`. Configure `MONGODB_URI` and `JWT_SECRET` in `.env` before starting. The shared package build is also part of the root `npm run build` command.

The API and seed scripts load `.env` from the repository root (and fall back to `apps/api/.env`). Copy `.env.example` to the repository-root `.env`, replace the MongoDB URI with a reachable local or Atlas URI, and replace the JWT placeholder with a strong random secret. To enable membership payments, add the Razorpay **Test Mode** API Key ID and Key Secret to `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`. Keep the secret server-side; only the Key ID is sent to the browser. The API waits for MongoDB before it starts listening on port 5000; if MongoDB cannot be reached, resolve that connection error before retrying the web login.

## Deploy frontend and API separately

- Deploy the repository's `apps/web` directory to Vercel as a Next.js project. Set the Vercel **Root Directory** to `apps/web`; its `vercel.json` builds the shared workspace package before Next.js.
- Create a Render Blueprint from the repository root using `render.yaml`. Enter `MONGODB_URI` and the exact frontend origin as `WEB_ORIGIN` (for example, `https://your-project.vercel.app`). Render generates `JWT_SECRET` for the API.
- The frontend proxies `/api/*` to `https://fitzone-api.onrender.com` by default. If Render assigns a different service URL, set `RENDER_API_URL` in Vercel to that origin only (no `/api` suffix or trailing slash) and redeploy. Browser requests and session cookies stay on the Vercel origin.
- Add `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` to the Render service only if membership payments are enabled. Never expose the Key Secret in Vercel or a `NEXT_PUBLIC_` variable.

The seed command creates public demo credentials for local development and exits without running in production. Before deploying, remove any demo accounts already present in the production database and set unique passwords for all real accounts. Use HTTPS in production and configure the exact `WEB_ORIGIN`; only set `TRUST_PROXY_HOPS` when requests pass through a known reverse proxy.

Run a complete test-mode checkout before switching both Razorpay environment values to **Live Mode** credentials. Razorpay must be configured to capture payments automatically; FitZone activates a renewal only after the server verifies the checkout signature and Razorpay reports the payment as `captured`. Never commit `.env` or put the Key Secret in a `NEXT_PUBLIC_` variable.

If the browser reports `ERR_CONNECTION_REFUSED` for port 5000 and the API logs a MongoDB Atlas server-selection or IP-whitelist error, allow your current development machine's IP in Atlas **Network Access**, then restart `npm run dev`. Avoid opening Atlas access to every IP address. If a real Atlas credential was ever placed in a shared or committed `.env.example`, rotate that database user's password.

## Demo accounts

All seeded accounts use the password `Demo@1234`.



Run `npm run seed` to add demo records without replacing existing records. Run `npm run seed:reset` to clear the FitZone collections and reseed them.

## Workflows currently implemented

- Owner-managed gym locations with a location switcher. Members, staff, trainers, plans, attendance, retention cases, products, and payments are scoped to one location; existing unassigned records are migrated to the owner's primary location.
- HTTP-only JWT cookie sign-in/out with role-gated API routes.
- Active member directory and owner/staff dashboard metrics backed by MongoDB queries and an aggregation.
- Assisted check-in with a required reason, rotating 30-second one-time QR-session tokens, active-membership validation, duplicate-window protection, and automatic resolution of an open retention case after a return.
- Daily 06:00 Asia/Kolkata inactivity scan and a manual scan endpoint. The default absence threshold is 10 days (`INACTIVITY_THRESHOLD_DAYS`); inactive, paused, frozen, expired, and cancelled accounts are excluded.
- Append-only retention follow-up outcomes, next-action dates, priority sorting, and WhatsApp message links.
- Membership plan listing, Razorpay order creation, server-side checkout signature and captured-status verification, idempotency-key protection, membership extension, and receipt-number issuance.
- Owner/staff dashboard, member directory, retention list, attendance desk, and member renewal/check-in portal.

Trainer scheduling, personal-training bookings, diet plans, supplement inventory, renewal reminder delivery, and the wider model set from the product brief are not yet implemented.

## Deployment security note

Next.js is pinned to the patched 15.5.27 release line. Run `npm audit` before deployment and keep the framework, Node.js runtime, and lockfile updated as new advisories are published.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start API and web development servers |
| `npm run build` | Build shared types, API, and Next.js app |
| `npm test` | Run API test suites |
| `npm run seed` | Seed demo accounts, members, plans, attendance, and retention cases |
| `npm run seed:reset` | Clear and reseed demo data |
| `npm run db:migrate-locations --workspace=apps/api` | Assign existing unscoped records to the primary gym location |

## Environment variables

See [.env.example](./.env.example) for the supported configuration.
