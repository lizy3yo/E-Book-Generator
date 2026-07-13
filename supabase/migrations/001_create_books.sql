-- ============================================================
-- Migration: 001_create_books
-- Run this in: Supabase Dashboard → SQL Editor
-- ============================================================

-- Books table — one row per book, full JSON payload stored in `data`
-- This keeps the schema simple while matching the app's Book type exactly.
create table if not exists public.books (
  id          uuid        primary key default gen_random_uuid(),
  data        jsonb       not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Auto-update updated_at on every row change
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger books_set_updated_at
  before update on public.books
  for each row execute procedure public.set_updated_at();

-- Index for fast lookups by the book's internal id stored in the JSON payload
create index if not exists books_data_id_idx on public.books ((data->>'id'));

-- ============================================================
-- Row Level Security (RLS)
-- ============================================================
-- This app currently has no auth layer.
-- Enable RLS and open all operations to the anon role for now.
-- Swap these policies for user-scoped ones once auth is added.

alter table public.books enable row level security;

create policy "anon can read books"
  on public.books for select
  using (true);

create policy "anon can insert books"
  on public.books for insert
  with check (true);

create policy "anon can update books"
  on public.books for update
  using (true);

create policy "anon can delete books"
  on public.books for delete
  using (true);
