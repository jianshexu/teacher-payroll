create extension if not exists "pgcrypto";

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists profiles_user_id_key on public.profiles(user_id);

create table if not exists public.one_on_one_students (
  id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  grade text not null,
  special_one numeric,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id, user_id)
);

create table if not exists public.classes (
  id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  grade text not null,
  students jsonb not null default '[]'::jsonb,
  fixed_price numeric,
  extra_per_student numeric not null default 10,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id, user_id)
);

create table if not exists public.class_students (
  id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  class_id text not null,
  name text not null,
  status text not null default 'active',
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id, user_id)
);

create table if not exists public.course_templates (
  id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  course_type text not null,
  grade text not null,
  student_ids jsonb not null default '[]'::jsonb,
  class_id text,
  class_name text,
  fixed_mode text not null default 'auto',
  fixed_price numeric,
  enabled boolean not null default true,
  sort_order numeric not null default 100,
  note text,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id, user_id)
);

create table if not exists public.salary_settings (
  id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  standards jsonb not null,
  default_small_extra numeric not null default 10,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id, user_id)
);

create table if not exists public.lesson_records (
  id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  template_id text,
  course_name text,
  course_type text not null,
  grade text not null,
  student_name text,
  class_id text,
  class_name text,
  attendance jsonb not null default '[]'::jsonb,
  attendance_count integer not null default 0,
  leave_count integer not null default 0,
  absent_count integer not null default 0,
  amount numeric not null default 0,
  price_source text,
  manual_amount numeric,
  note text,
  confirmed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id, user_id)
);

alter table public.profiles enable row level security;
alter table public.one_on_one_students enable row level security;
alter table public.classes enable row level security;
alter table public.class_students enable row level security;
alter table public.course_templates enable row level security;
alter table public.salary_settings enable row level security;
alter table public.lesson_records enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
drop policy if exists "profiles_insert_own" on public.profiles;
drop policy if exists "profiles_update_own" on public.profiles;
drop policy if exists "profiles_delete_own" on public.profiles;
create policy "profiles_select_own" on public.profiles for select using (auth.uid() = user_id);
create policy "profiles_insert_own" on public.profiles for insert with check (auth.uid() = user_id);
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "profiles_delete_own" on public.profiles for delete using (auth.uid() = user_id);

drop policy if exists "students_select_own" on public.one_on_one_students;
drop policy if exists "students_insert_own" on public.one_on_one_students;
drop policy if exists "students_update_own" on public.one_on_one_students;
drop policy if exists "students_delete_own" on public.one_on_one_students;
create policy "students_select_own" on public.one_on_one_students for select using (auth.uid() = user_id);
create policy "students_insert_own" on public.one_on_one_students for insert with check (auth.uid() = user_id);
create policy "students_update_own" on public.one_on_one_students for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "students_delete_own" on public.one_on_one_students for delete using (auth.uid() = user_id);

drop policy if exists "classes_select_own" on public.classes;
drop policy if exists "classes_insert_own" on public.classes;
drop policy if exists "classes_update_own" on public.classes;
drop policy if exists "classes_delete_own" on public.classes;
create policy "classes_select_own" on public.classes for select using (auth.uid() = user_id);
create policy "classes_insert_own" on public.classes for insert with check (auth.uid() = user_id);
create policy "classes_update_own" on public.classes for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "classes_delete_own" on public.classes for delete using (auth.uid() = user_id);

drop policy if exists "class_students_select_own" on public.class_students;
drop policy if exists "class_students_insert_own" on public.class_students;
drop policy if exists "class_students_update_own" on public.class_students;
drop policy if exists "class_students_delete_own" on public.class_students;
create policy "class_students_select_own" on public.class_students for select using (auth.uid() = user_id);
create policy "class_students_insert_own" on public.class_students for insert with check (auth.uid() = user_id);
create policy "class_students_update_own" on public.class_students for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "class_students_delete_own" on public.class_students for delete using (auth.uid() = user_id);

drop policy if exists "templates_select_own" on public.course_templates;
drop policy if exists "templates_insert_own" on public.course_templates;
drop policy if exists "templates_update_own" on public.course_templates;
drop policy if exists "templates_delete_own" on public.course_templates;
create policy "templates_select_own" on public.course_templates for select using (auth.uid() = user_id);
create policy "templates_insert_own" on public.course_templates for insert with check (auth.uid() = user_id);
create policy "templates_update_own" on public.course_templates for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "templates_delete_own" on public.course_templates for delete using (auth.uid() = user_id);

drop policy if exists "settings_select_own" on public.salary_settings;
drop policy if exists "settings_insert_own" on public.salary_settings;
drop policy if exists "settings_update_own" on public.salary_settings;
drop policy if exists "settings_delete_own" on public.salary_settings;
create policy "settings_select_own" on public.salary_settings for select using (auth.uid() = user_id);
create policy "settings_insert_own" on public.salary_settings for insert with check (auth.uid() = user_id);
create policy "settings_update_own" on public.salary_settings for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "settings_delete_own" on public.salary_settings for delete using (auth.uid() = user_id);

drop policy if exists "records_select_own" on public.lesson_records;
drop policy if exists "records_insert_own" on public.lesson_records;
drop policy if exists "records_update_own" on public.lesson_records;
drop policy if exists "records_delete_own" on public.lesson_records;
create policy "records_select_own" on public.lesson_records for select using (auth.uid() = user_id);
create policy "records_insert_own" on public.lesson_records for insert with check (auth.uid() = user_id);
create policy "records_update_own" on public.lesson_records for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "records_delete_own" on public.lesson_records for delete using (auth.uid() = user_id);
