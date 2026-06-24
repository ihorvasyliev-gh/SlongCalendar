# SlongCalendar (Susan Booking System)

A self-hosted, premium booking and calendar system resembling **Calendly.com**. It integrates with Facebook Messenger and Instagram Direct, synchronizing bookings to Google Calendar and using Supabase as a database backend.

## Architecture

1. **Frontend (`public/index.html`)**: A single-page application built with React, styled with Tailwind CSS, featuring a monthly calendar, timezone auto-detection, and a slide-out slot selector with confirmation micro-interactions.
2. **Backend Worker (`src/`)**: A Cloudflare Worker built in TypeScript that handles token generation, checks busy times on Google Calendar, manages DB bookings, and interacts with the Meta Graph API to send confirmations.
3. **Database (`supabase_schema.sql`)**: Supabase PostgreSQL database schemas for tracking active appointments and one-time booking tokens.

---

## Features

- **Calendly-like UI**: 3-panel split layout on desktop, responsive slide-out slot select animation, slot-confirm protection ("Time Slot" -> "Next" -> "Details form").
- **Secure One-Time Links**: Protects against automated scraping and spam by generating temporary 24-hour booking tokens directly inside Messenger or Instagram Direct chats.
- **Google Calendar Sync**: Double-booking protection by checking current Google Calendar busy times in real-time.

---

## Configuration

To run and deploy the system, configure the following secrets on your Cloudflare Worker:

- `SUPABASE_SERVICE_ROLE_KEY`: Your Supabase API service role key (bypasses RLS to write bookings).
- `META_VERIFY_TOKEN`: Your Meta webhook verification token.
- `META_PAGE_ACCESS_TOKEN`: Page access token to message clients back.
- `META_APP_SECRET`: App secret for payload validation.
- `GOOGLE_PRIVATE_KEY`: Private RSA key from your Google Cloud Service Account.

Variables inside `wrangler.json`:
- `SUPABASE_URL`: Supabase project URL.
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`: Google service account client email.
- `GOOGLE_CALENDAR_ID`: The target Google Calendar ID (default is `primary`).
- `BUSINESS_TIMEZONE`: Timezone for booking calculations (e.g. `Europe/Dublin`).
- `BUSINESS_START_HOUR` / `BUSINESS_END_HOUR`: Working hours limits.
- `BOOKING_URL`: The deployed Cloudflare Pages URL where the frontend is hosted.

---

## Deployment

### 1. Database Setup
Execute the SQL commands in `supabase_schema.sql` inside your Supabase SQL Editor.

### 2. Backend Worker Deployment
Deploy the worker with:
```bash
npx wrangler deploy
```

### 3. Frontend Pages Deployment
Deploy the static folder to Cloudflare Pages:
```bash
npx wrangler pages deploy public --project-name slong-booking
```
