-- LOCK-IN GIVEAWAY: use only in a NEW, dedicated Supabase project.
-- This migration intentionally creates no public select/insert/update policies.

create table if not exists public.contest_settings (
  id boolean primary key default true check (id = true),
  registration_open boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.contest_entries (
  id uuid primary key default gen_random_uuid(),
  display_name text not null check (char_length(btrim(display_name)) between 2 and 50),
  chosen_code text not null unique check (chosen_code ~ '^[0-9]{5}$'),
  receipt_digest text not null check (length(receipt_digest) = 64),
  ip_digest text,
  created_at timestamptz not null default now()
);

create index if not exists contest_entries_ip_digest_created_idx
  on public.contest_entries(ip_digest, created_at);

create table if not exists public.contest_prizes (
  id smallint primary key,
  title text not null,
  winner_limit smallint not null check (winner_limit > 0)
);

create table if not exists public.contest_draws (
  id uuid primary key default gen_random_uuid(),
  prize_id smallint not null references public.contest_prizes(id) on delete restrict,
  entry_id uuid not null unique references public.contest_entries(id) on delete restrict,
  hidden_position smallint not null check (hidden_position between 0 and 4),
  published boolean not null default false,
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists contest_draws_prize_idx on public.contest_draws(prize_id);

create table if not exists public.contest_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

insert into public.contest_settings(id, registration_open)
values (true, true) on conflict (id) do nothing;

insert into public.contest_prizes(id, title, winner_limit) values
 (1, 'اشتراك Lock-in مجاني', 2),
 (2, 'خصم 75% على اشتراك Lock-in', 1),
 (3, 'خصم 50% على اشتراك Lock-in', 2),
 (4, 'خصم 25% على اشتراك Lock-in', 1)
on conflict (id) do nothing;

-- Defense in depth: even users with Supabase Auth accounts cannot read contestant codes or receipts.
alter table public.contest_settings enable row level security;
alter table public.contest_entries enable row level security;
alter table public.contest_prizes enable row level security;
alter table public.contest_draws enable row level security;
alter table public.contest_admins enable row level security;

revoke all on public.contest_settings, public.contest_entries, public.contest_prizes,
  public.contest_draws, public.contest_admins from anon, authenticated;

-- Race-safe and server-only: serializes all draws through the singleton settings row.
-- The service_role is allowed to call this function; anonymous users NEVER are.
create or replace function public.contest_draw(p_prize_id smallint)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_limit smallint;
  v_used integer;
  v_entry_id uuid;
  v_draw_id uuid;
  v_registration_open boolean;
begin
  select registration_open into v_registration_open
  from public.contest_settings where id = true for update;
  if not found then
    raise exception 'SETTINGS_NOT_FOUND';
  end if;
  if v_registration_open then
    raise exception 'CLOSE_REGISTRATION_FIRST';
  end if;

  select winner_limit into v_limit
  from public.contest_prizes where id = p_prize_id for update;
  if not found then
    raise exception 'PRIZE_NOT_FOUND';
  end if;

  select count(*) into v_used from public.contest_draws where prize_id = p_prize_id;
  if v_used >= v_limit then
    raise exception 'PRIZE_FINISHED';
  end if;

  select e.id into v_entry_id
  from public.contest_entries e
  where not exists (select 1 from public.contest_draws d where d.entry_id = e.id)
  order by random()
  limit 1;

  if v_entry_id is null then
    raise exception 'NO_ELIGIBLE_ENTRIES';
  end if;

  insert into public.contest_draws(prize_id, entry_id, hidden_position)
  values (p_prize_id, v_entry_id, floor(random()*5)::smallint)
  returning id into v_draw_id;

  return v_draw_id;
end;
$$;

revoke all on function public.contest_draw(smallint) from public, anon, authenticated;
grant execute on function public.contest_draw(smallint) to service_role;

-- After creating a user manually in Authentication > Users, paste their UID below
-- and execute ONLY that statement separately in SQL Editor:
-- insert into public.contest_admins(user_id) values ('PASTE-AUTH-USER-UUID') on conflict do nothing;

-- Atomic registration, serialized against closing registration and all draws.
-- Only callable using the Edge Function's service-role key.
create or replace function public.contest_register(
  p_name text,
  p_code text,
  p_receipt_digest text,
  p_ip_digest text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_open boolean;
  v_count integer;
  v_id uuid;
begin
  select registration_open into v_open
  from public.contest_settings where id = true for update;
  if not found or not v_open then
    raise exception 'REGISTRATION_CLOSED';
  end if;
  if p_ip_digest is not null then
    select count(*) into v_count from public.contest_entries
    where ip_digest = p_ip_digest;
    if v_count >= 30 then
      raise exception 'IP_RATE_LIMIT';
    end if;
  end if;
  insert into public.contest_entries(display_name, chosen_code, receipt_digest, ip_digest)
  values (p_name, p_code, p_receipt_digest, p_ip_digest)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.contest_register(text,text,text,text) from public, anon, authenticated;
grant execute on function public.contest_register(text,text,text,text) to service_role;

-- Never allow reopening the registration after the first draw has happened.
create or replace function public.contest_set_registration(p_open boolean)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform 1 from public.contest_settings where id = true for update;
  if not found then raise exception 'SETTINGS_NOT_FOUND'; end if;
  if p_open and exists (select 1 from public.contest_draws) then
    raise exception 'CANNOT_REOPEN_AFTER_DRAW';
  end if;
  update public.contest_settings
  set registration_open = p_open, updated_at = now()
  where id = true;
  return p_open;
end;
$$;
revoke all on function public.contest_set_registration(boolean) from public, anon, authenticated;
grant execute on function public.contest_set_registration(boolean) to service_role;
