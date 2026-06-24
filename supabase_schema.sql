-- Supabase Database Schema for Meta-Integrated Booking System

-- 1. Create booking_tokens table
create table if not exists booking_tokens (
  id uuid primary key default gen_random_uuid(),
  token uuid default gen_random_uuid() not null unique,
  sender_id text not null,
  platform text not null check (platform in ('facebook', 'instagram')),
  used boolean default false not null,
  expires_at timestamptz not null,
  created_at timestamptz default now() not null
);

-- Index on token for fast verification lookups
create index if not exists idx_booking_tokens_token on booking_tokens(token);

-- 2. Create appointments table
create table if not exists appointments (
  id uuid primary key default gen_random_uuid(),
  client_name text not null,
  client_email text not null,
  client_phone text,
  start_time timestamptz not null,
  end_time timestamptz not null,
  status text default 'confirmed' not null check (status in ('confirmed', 'cancelled')),
  token_id uuid references booking_tokens(id) on delete set null,
  google_event_id text,
  created_at timestamptz default now() not null
);

-- Index on appointment times and status to filter out already booked slots
create index if not exists idx_appointments_time_status on appointments(start_time, end_time) where status = 'confirmed';

-- 3. Enable Row Level Security (RLS)
-- Enabling RLS without any policies blocks all public anon/authenticated access,
-- while the Cloudflare Worker using the service_role key will bypass RLS.
alter table booking_tokens enable row level security;
alter table appointments enable row level security;
