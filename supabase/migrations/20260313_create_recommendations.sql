-- Create recommendations table to store checkout recommendation history
create table if not exists recommendations (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  store_name text not null,
  purchase_amount numeric,
  recommended_card_name text not null,
  recommended_card_bank text not null,
  reason text,
  estimated_rewards numeric,
  created_at timestamptz default now() not null
);

-- Enable RLS
alter table recommendations enable row level security;

-- Users can only read their own recommendations
create policy "Users can read own recommendations"
  on recommendations for select
  using (auth.uid() = user_id);

-- Users can insert their own recommendations
create policy "Users can insert own recommendations"
  on recommendations for insert
  with check (auth.uid() = user_id);

-- Index for fast lookups by user
create index idx_recommendations_user_id on recommendations(user_id);
create index idx_recommendations_created_at on recommendations(created_at desc);
