# MAS Zonas

Herramienta para armar y editar las zonas de visita de los vendedores de 611, tipo AXUM:
cada **manzana** (polígono que forman las calles de OpenStreetMap) tiene una **zona** (vendedor)
y un **día** (lunes a viernes). Como las zonas son manzanas enteras, los bordes siempre van por calles.

- Propuestas: ZZ (rezonificación tal cual vino: rutas, días y semanas del ciclo de 4) y WW611
  (la misma propuesta con el recorrido de cada día optimizado).
- Selector de semana del ciclo (1-4) y ruta de cada día en orden de visita.
- Vistas: días (toda la ciudad), zonas de un día, una zona con sus 5 días.
- Edición con pincel o lazo, deshacer, guardar (Supabase), exportar KML para AXUM y CSV de clientes.

## Datos

- `manzanas.json` (público, solo calles de OSM).
- Clientes y zona/día por manzana: en Supabase (mismo proyecto que MAS Recepción), solo usuarios admin.
  Tablas en `supabase/schema.sql`.
- Para probar sin Supabase: `?local` con `datos/local/` (no se sube: tiene datos de clientes).

## Regenerar (desde `datos/`, que no se sube)

1. `osm/calles.json`: calles de Overpass (bbox de los clientes).
2. `python ../scripts/manzanas.py` → `manzanas.json` + `cliente_manzana.json` (copiar `manzanas.json` a la raíz).
3. `python ../scripts/zonificar.py` → `asignacion.json` (necesita `clientes_esc.csv` del reporte y `dias_gescom.json`).
4. `python scripts/generar_carga.py` → SQL de carga en `datos/local/`.

Ojo: si se regeneran las manzanas cambian los ids y se pierden las ediciones guardadas.
