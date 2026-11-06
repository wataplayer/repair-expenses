create table if not exists expenses (
  id text primary key,
  spent_on text not null check (spent_on >= '2000-01-01' and spent_on <= '2100-12-31'),
  amount_kopecks integer not null check (amount_kopecks >= 1 and amount_kopecks <= 9999999999),
  category text not null check (category in ('materials', 'work', 'delivery', 'tools', 'other')),
  note text not null default '' check (length(note) <= 200),
  receipt_key text,
  receipt_type text,
  created_at text not null
);

create index if not exists expenses_order_idx on expenses (spent_on desc, created_at desc);

create table if not exists uploads (
  id text primary key,
  spent_on text not null,
  amount_kopecks integer not null,
  category text not null,
  note text not null,
  total_bytes integer not null,
  content_type text not null,
  parts integer not null,
  assembled integer not null default 0,
  expense_id text
);

create table if not exists upload_parts (
  upload_id text not null,
  part_index integer not null,
  bytes blob not null,
  primary key (upload_id, part_index)
);
