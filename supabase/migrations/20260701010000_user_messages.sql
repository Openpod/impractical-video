create table if not exists public.user_messages (
  id uuid not null default gen_random_uuid(),
  audience_type text not null default 'all_users' check (audience_type in ('all_users')),
  status text not null default 'published' check (status in ('draft', 'published', 'archived')),
  title text not null,
  subtext text,
  thumbnail_url text,
  external_url text,
  action_type text,
  action_label text,
  action_payload jsonb not null default '{}'::jsonb,
  published_at timestamp with time zone not null default now(),
  expires_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint user_messages_pkey primary key (id)
);

create index if not exists user_messages_audience_published_idx
  on public.user_messages (audience_type, status, published_at desc);

create table if not exists public.user_message_deliveries (
  id uuid not null default gen_random_uuid(),
  message_id uuid not null references public.user_messages(id) on delete cascade,
  user_id text not null,
  read_at timestamp with time zone,
  action_completed_at timestamp with time zone,
  action_result jsonb,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint user_message_deliveries_pkey primary key (id),
  constraint user_message_deliveries_message_user_key unique (message_id, user_id)
);

create index if not exists user_message_deliveries_user_created_idx
  on public.user_message_deliveries (user_id, created_at desc);

create or replace function public.set_user_messages_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_messages_set_updated_at on public.user_messages;
create trigger user_messages_set_updated_at
before update on public.user_messages
for each row
execute function public.set_user_messages_updated_at();

drop trigger if exists user_message_deliveries_set_updated_at on public.user_message_deliveries;
create trigger user_message_deliveries_set_updated_at
before update on public.user_message_deliveries
for each row
execute function public.set_user_messages_updated_at();

alter table public.user_messages enable row level security;
alter table public.user_message_deliveries enable row level security;
