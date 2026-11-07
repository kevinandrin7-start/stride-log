-- Stride Log database. Paste all of this into Supabase: SQL Editor -> New query -> Run.

-- Every record the app keeps (logs, daily watch stats, settings, reminders).
create table if not exists public.docs (
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  coll text not null,          -- 'logs' | 'daily' | 'settings' | 'reminders'
  id text not null,            -- e.g. '2026-11-10', 'main'
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, coll, id)
);
alter table public.docs enable row level security;
drop policy if exists "own docs" on public.docs;
create policy "own docs" on public.docs for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Phones that get workout reminders.
create table if not exists public.push_subs (
  endpoint text primary key,
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  sub jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.push_subs enable row level security;
drop policy if exists "own subs" on public.push_subs;
create policy "own subs" on public.push_subs for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Secret link token the iPhone Shortcut uses to send nightly Health stats.
create table if not exists public.ingest_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade default auth.uid(),
  token text not null unique default (replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','')),
  created_at timestamptz not null default now()
);
alter table public.ingest_tokens enable row level security;
drop policy if exists "own token" on public.ingest_tokens;
create policy "own token" on public.ingest_tokens for select using (user_id = auth.uid());
drop policy if exists "make token" on public.ingest_tokens;
create policy "make token" on public.ingest_tokens for insert with check (user_id = auth.uid());

-- Server-only key store (push keys). No policies: only the server can read it.
create table if not exists public.server_kv (k text primary key, v jsonb not null);
alter table public.server_kv enable row level security;

-- Private bucket for workout screenshots, one folder per user.
insert into storage.buckets (id, name, public) values ('shots', 'shots', false)
  on conflict (id) do nothing;
drop policy if exists "own shots" on storage.objects;
create policy "own shots" on storage.objects for all
  using (bucket_id = 'shots' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'shots' and (storage.foldername(name))[1] = auth.uid()::text);
