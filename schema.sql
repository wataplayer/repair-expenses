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
