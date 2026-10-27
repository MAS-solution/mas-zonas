-- MAS Zonas — tablas en el mismo proyecto de Supabase que MAS Recepción (usa sus usuarios y perfiles).
-- Solo los usuarios con rol admin ven y editan. Idempotente.

create or replace function public.zonas_es_admin() returns boolean
  language sql stable security definer set search_path = public
  as $$ select exists (select 1 from public.perfiles where id = auth.uid() and rol = 'admin') $$;

-- Clientes (foto del reporte de reestructuración; manzana = id de manzanas.json)
create table if not exists public.zonas_clientes (
  codigo    text primary key,
  cliente   text not null,
  vendedor  text not null,
  segmento  text,
  fact_mes  numeric not null default 0,
  estado    text not null,
  lat       double precision not null,
  lng       double precision not null,
  manzana   integer not null
);

-- Zona y día de cada manzana por escenario (escenario = cantidad de vendedores en la calle)
create table if not exists public.zonas_asignacion (
  escenario   integer not null,
  manzana     integer not null,
  zona        integer not null,
  dia         integer not null check (dia between 1 and 5),
  editado_por uuid references auth.users(id),
  editado_en  timestamptz not null default now(),
  primary key (escenario, manzana)
);

alter table public.zonas_clientes   enable row level security;
alter table public.zonas_asignacion enable row level security;

drop policy if exists zonas_clientes_ver on public.zonas_clientes;
create policy zonas_clientes_ver on public.zonas_clientes for select to authenticated using (public.zonas_es_admin());

drop policy if exists zonas_asig_ver on public.zonas_asignacion;
create policy zonas_asig_ver on public.zonas_asignacion for select to authenticated using (public.zonas_es_admin());

-- Guarda varios cambios juntos y deja quién y cuándo (la única forma de escribir desde la app)
create or replace function public.zonas_guardar(p_escenario integer, p_cambios jsonb) returns integer
  language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.zonas_es_admin() then raise exception 'sin permiso'; end if;
  update public.zonas_asignacion a
     set zona = (c->>'zona')::int, dia = (c->>'dia')::int, editado_por = auth.uid(), editado_en = now()
    from jsonb_array_elements(p_cambios) c
   where a.escenario = p_escenario and a.manzana = (c->>'manzana')::int;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.zonas_guardar(integer, jsonb) from public, anon;
grant execute on function public.zonas_guardar(integer, jsonb) to authenticated;


-- Visitas de una propuesta de afuera (escenario >= 100): en qué semana del ciclo de 4 se visita cada cliente,
-- en qué orden dentro del día, y su ruta (zona) y día según la propuesta (cliente por cliente, no por manzana).
create table if not exists public.zonas_visitas (
  escenario integer not null,
  codigo    text not null references public.zonas_clientes(codigo) on delete cascade,
  semana    smallint not null check (semana between 1 and 4),
  orden     integer,
  zona      integer not null,
  dia       smallint not null check (dia between 1 and 6),
  primary key (escenario, codigo, semana)
);
alter table public.zonas_visitas enable row level security;
drop policy if exists zonas_visitas_ver on public.zonas_visitas;
create policy zonas_visitas_ver on public.zonas_visitas for select to authenticated using (public.zonas_es_admin());
