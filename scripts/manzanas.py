# Manzanas = polígonos que forman las calles de OSM (cada borde es una calle).
# Salida: manzanas.json (id, anillo en lat/lng) y cliente_manzana.json (codigo -> id de manzana).
import json, math, csv
import numpy as np
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union, polygonize
from shapely.strtree import STRtree

LAT0, LON0 = -31.4, -64.2
KX, KY = 111320 * math.cos(math.radians(LAT0)), 110540
xy = lambda lo, la: ((lo - LON0) * KX, (la - LAT0) * KY)
ll = lambda x, y: (round(x / KX + LON0, 6), round(y / KY + LAT0, 6))

cli = [r for r in csv.DictReader(open('clientes_esc.csv', encoding='utf-8')) if r['en_mapa'] == 'si']
P = np.array([xy(float(r['lng']), float(r['lat'])) for r in cli])
osm = json.load(open('osm/calles.json', encoding='utf-8'))
# solo calles a menos de 1,5 km de algún cliente (grilla de 500 m)
celda = 500
ocup = {(int(x // celda), int(y // celda)) for x, y in P}
cerca = lambda x, y: any((int(x // celda) + i, int(y // celda) + j) in ocup for i in range(-3, 4) for j in range(-3, 4))
lineas = []
for w in osm['elements']:
    g = [xy(p['lon'], p['lat']) for p in w.get('geometry', [])]
    if len(g) >= 2 and any(cerca(*p) for p in g): lineas.append(LineString(g))
print('calles', len(lineas))
red = unary_union(lineas)
bloques = [p for p in polygonize(red) if p.area > 50]
print('manzanas', len(bloques))
# quedarse con manzanas a menos de 1 km de un cliente
arbol = STRtree(bloques)
pts = [Point(p) for p in P]
cerca_cli = set()
for i, p in enumerate(pts):
    for j in arbol.query(p.buffer(1000)): cerca_cli.add(int(j))
bloques = [bloques[j] for j in sorted(cerca_cli)]
arbol = STRtree(bloques)
asig = {}
sin = 0
for r, p in zip(cli, pts):
    js = [int(j) for j in arbol.query(p, predicate='within')]
    if js: asig[r['codigo']] = js[0]
    else:
        j = int(arbol.nearest(p)); asig[r['codigo']] = j; sin += 1
print('manzanas finales', len(bloques), 'clientes fuera de manzana (a la más cercana)', sin)
out = []
for i, b in enumerate(bloques):
    out.append({'id': i, 'a': round(b.area), 'r': [ll(x, y) for x, y in b.exterior.coords]})
json.dump(out, open('manzanas.json', 'w'), separators=(',', ':'))
json.dump(asig, open('cliente_manzana.json', 'w'), separators=(',', ':'))
import os; print(os.path.getsize('manzanas.json') // 1024, 'KB')
