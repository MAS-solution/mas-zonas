# Zonas y días por manzana para cada escenario. Una zona = manzanas enteras (los bordes son calles).
# Los días se respetan: cada manzana queda con el día que la mayoría de sus clientes ya tiene en la ruta
# de Gescom (dias_gescom.json; los de sábado toman el día de sus vecinos). Las zonas se arman alrededor
# de eso: crecen por calles desde N centros (los de las zonas del reporte) y cada una junta la misma
# cantidad de clientes de cada día, así cada vendedor tiene ~1/5 de su zona por día.
import json, csv, math, collections
import numpy as np
from scipy.optimize import linear_sum_assignment

DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes']
man = json.load(open('manzanas.json'))
cm = json.load(open('cliente_manzana.json'))
cli = [r for r in csv.DictReader(open('clientes_esc.csv', encoding='utf-8')) if r['en_mapa'] == 'si']
ESC = sorted({int(k[5:]) for k in cli[0] if k.startswith('zona_')}, reverse=True)
n = len(man)
cen = np.array([np.mean(m['r'], axis=0) for m in man])  # lng, lat
cxy = np.column_stack([cen[:, 0] * 95.0, cen[:, 1] * 110.5])  # km aprox.

# vecinas = comparten un tramo de calle
seg = collections.defaultdict(list)
for m in man:
    r = [tuple(p) for p in m['r']]
    for a, b in zip(r, r[1:]): seg[(a, b) if a < b else (b, a)].append(m['id'])
vec = [set() for _ in range(n)]
for ids in seg.values():
    for i in ids:
        for j in ids:
            if i != j: vec[i].add(j)
print('manzanas', n, 'sin vecinas', sum(1 for v in vec if not v))

visita = [r for r in cli if r['estado'] == 'Visita' and r['zona_' + str(ESC[0])]]
DIA_G = {}
for r in json.load(open('dias_gescom.json', encoding='utf-8')):
    for d, k in enumerate(('l', 'm', 'x', 'j', 'vi')):
        if r[k]: DIA_G[r['codigo']] = d
peso = np.zeros(n, int)
for r in visita: peso[cm[r['codigo']]] += 1

def rellenar(lab, dentro=None):
    """Manzanas sin clientes: toman la etiqueta de la vecina más cercana por calles (BFS); si no hay camino, la más cercana en línea recta."""
    lab = lab.copy()
    q = collections.deque(i for i in range(n) if lab[i] >= 0 and (dentro is None or dentro[i]))
    while q:
        i = q.popleft()
        for j in vec[i]:
            if lab[j] < 0 and (dentro is None or dentro[j]): lab[j] = lab[i]; q.append(j)
    falt = [i for i in range(n) if lab[i] < 0 and (dentro is None or dentro[i])]
    ok = np.array([i for i in range(n) if lab[i] >= 0 and (dentro is None or dentro[i])])
    for i in falt: lab[i] = lab[ok[np.argmin(((cxy[ok] - cxy[i]) ** 2).sum(1))]]
    return lab

def equilibrar(lab, k, sel, tol):
    """Pasa manzanas de borde de la parte más cargada a una vecina menos cargada hasta que la diferencia sea <= tol."""
    for _ in range(20000):
        cnt = collections.Counter({c: 0 for c in range(k)}); cnt.update({c: 0 for c in range(k)})
        for i in sel: cnt[lab[i]] += peso[i]
        hi = max(cnt, key=cnt.get); lo_ = min(cnt.values())
        if cnt[hi] - lo_ <= tol: break
        mejor = None
        for i in sel:
            if lab[i] != hi or peso[i] == 0: continue
            otras = {lab[j] for j in vec[i] if lab[j] != hi and lab[j] >= 0 and j in selset}
            for c in otras:
                if cnt[c] + peso[i] < cnt[hi] - peso[i] + 1e-9 or cnt[c] + peso[i] <= cnt[hi]:
                    # que la manzana siga pegada a su parte nueva y no deje aislada a su parte vieja
                    misma = [j for j in vec[i] if lab[j] == hi and j in selset]
                    key = (cnt[c], peso[i])
                    if misma and (mejor is None or key < mejor[0]): mejor = (key, i, c)
        if not mejor: break
        _, i, c = mejor; lab[i] = c
    return lab

def biseccion(idx, k, w):
    if k == 1: return [idx]
    P = cxy[idx]; ww = w[idx].astype(float) + 1e-3
    m = (P * ww[:, None]).sum(0) / ww.sum()
    C = np.cov((P - m).T, aweights=ww); v = np.linalg.eigh(C)[1][:, -1]
    pr = (P - m) @ v; o = np.argsort(pr); acum = np.cumsum(ww[o]); k1 = k // 2
    corte = int(np.searchsorted(acum, acum[-1] * k1 / k)) + 1
    return biseccion(idx[o[:corte]], k1, w) + biseccion(idx[o[corte:]], k - k1, w)

# Día de cada manzana: el de la mayoría de sus clientes en Gescom (los de sábado toman el de sus vecinos)
vd = collections.defaultdict(collections.Counter)
for r in visita:
    if r['codigo'] in DIA_G: vd[cm[r['codigo']]][DIA_G[r['codigo']]] += 1
dia = np.full(n, -1)
for i, c in vd.items(): dia[i] = c.most_common(1)[0][0]
dia = rellenar(dia)
igual = sum(1 for r in visita if DIA_G.get(r['codigo']) == dia[cm[r['codigo']]])
print('clientes que mantienen su día', igual, 'de', len(visita), f'({100 * igual / len(visita):.0f}%)')
CENTRO = np.average(cxy, axis=0, weights=peso + 1e-9)

def cortes_rectos(idx, k, tol_rel=0.02):
    """Parte las manzanas idx en k partes con cortes rectos norte-sur o este-oeste (la cuadrícula de
    Córdoba va así), repartiendo los clientes en proporción. Cada corte cae en el hueco más ancho
    entre manzanas dentro de un margen del 2% de clientes: o sea, sobre una calle, sin escalones."""
    if k == 1: return [idx]
    w = peso[idx].astype(float); P = cxy[idx]
    con = w > 0
    eje = int(np.argmax([np.sqrt(np.cov(P[con, e], aweights=w[con])) for e in (0, 1)]))
    o = np.argsort(P[:, eje]); xs = P[o, eje]; acum = np.cumsum(w[o]); tot = acum[-1]
    k1 = k // 2; meta = tot * k1 / k; tol = max(3.0, tot * tol_rel)
    cand = [i for i in range(len(o) - 1) if abs(acum[i] - meta) <= tol and xs[i + 1] > xs[i]]
    if not cand: cand = [int(np.argmin(np.abs(acum[:-1] - meta)))]
    # el hueco más ancho, desempatando por cercanía a la meta
    i = max(cand, key=lambda i: (round((xs[i + 1] - xs[i]) * 1000, 0), -abs(acum[i] - meta)))
    return cortes_rectos(idx[o[:i + 1]], k1, tol_rel) + cortes_rectos(idx[o[i + 1:]], k - k1, tol_rel)

def zonas_del_dia(d, N):
    """Parte las manzanas del día d en N subzonas con cortes rectos."""
    idx = np.where(dia == d)[0]
    partes = cortes_rectos(idx, N)
    lab = np.full(n, -1)
    for k, parte in enumerate(partes): lab[parte] = k
    return lab

def emparejar(piezas, N):
    """Qué pedazo de cada día va con cada zona: el lunes se numera por ángulo alrededor del centro y
    los otros días se asignan (asignación óptima) buscando que los totales de la semana queden parejos
    y que cada zona caiga más o menos para el mismo lado de la ciudad."""
    info = []
    for d in range(5):
        lab = piezas[d]; idx = np.where(dia == d)[0]; fila = []
        for k in range(N):
            ii = idx[(lab[idx] == k) & (peso[idx] > 0)]
            c = np.average(cxy[ii], axis=0, weights=peso[ii]) - CENTRO
            fila.append((np.arctan2(c[1], c[0]), peso[ii].sum()))
        info.append(fila)
    orden0 = np.argsort([a for a, _ in info[0]])
    mapa = [dict() for _ in range(5)]
    tot = np.zeros(N); ang = np.zeros(N)
    for z, k in enumerate(orden0): mapa[0][k] = z; tot[z] = info[0][k][1]; ang[z] = info[0][k][0]
    for d in sorted(range(1, 5), key=lambda d: -np.ptp([w for _, w in info[d]])):
        sz = np.array([w for _, w in info[d]]); an = np.array([a for a, _ in info[d]])
        meta = tot.mean() + sz.mean()
        da = np.abs((an[:, None] - ang[None, :] + np.pi) % (2 * np.pi) - np.pi)
        cost = (tot[None, :] + sz[:, None] - meta) ** 2 + 8.0 * da
        r_, c_ = linear_sum_assignment(cost)
        for k, z in zip(r_, c_): mapa[d][k] = z; tot[z] += sz[k]
    zona = np.full(n, -1)
    for d in range(5):
        idx = np.where(dia == d)[0]
        zona[idx] = [mapa[d][k] for k in piezas[d][idx]]
    return zona

def componentes(lab):
    vis = np.zeros(n, bool); comps = []
    for s in range(n):
        if vis[s]: continue
        q = [s]; vis[s] = True; c = []
        while q:
            i = q.pop(); c.append(i)
            for j in vec[i]:
                if not vis[j] and lab[j] == lab[i]: vis[j] = True; q.append(j)
        comps.append(np.array(c))
    return comps

def limpiar_islas(zona, dia, max_chica=10, max_lejos=0):
    """Pedazos sueltos de una zona-día (separados del resto de su pedazo): si son chicos o quedan más
    cerca de otra zona que de la propia, pasan a la zona y el día del pedazo que los rodea, aunque eso
    les cambie el día de visita."""
    zona = zona.copy(); dia = dia.copy(); movidos = 0
    for _ in range(10):
        lab = zona * 10 + dia; cambio = False
        comps = componentes(lab)
        grande = {}
        for c in comps:
            l = lab[c[0]]; w = peso[c].sum()
            if l not in grande or w > grande[l][0]: grande[l] = (w, c)
        for c in comps:
            l = lab[c[0]]
            if grande[l][1] is c: continue
            w = peso[c].sum()
            borde = collections.Counter(lab[j] for i in c for j in vec[i] if lab[j] != l)
            if w > 0:
                cc = cxy[c[peso[c] > 0]].mean(0)
                otros = np.where((lab != l) & (peso > 0))[0]
                propio = grande[l][1][peso[grande[l][1]] > 0]
                d_otro = np.sqrt(((cxy[otros] - cc) ** 2).sum(1)).min()
                d_prop = np.sqrt(((cxy[propio] - cc) ** 2).sum(1)).min() if len(propio) else 1e9
                if w > max_chica and not (w <= max_lejos and d_otro < d_prop): continue
                if not borde: borde = collections.Counter([lab[otros[np.argmin(((cxy[otros] - cc) ** 2).sum(1))]]])
            elif not borde: continue
            nuevo = borde.most_common(1)[0][0]
            zona[c] = nuevo // 10; dia[c] = nuevo % 10; movidos += w; cambio = True
            lab[c] = nuevo
        if not cambio: break
    return zona, dia, movidos

# Clientes sueltos de un día metidos en el sector de otro día (grupitos de 1 o 2) pasan al día que los rodea
_, dia, mov = limpiar_islas(np.zeros(n, int), dia, max_chica=2)
igual = sum(1 for r in visita if DIA_G.get(r['codigo']) == dia[cm[r['codigo']]])
print('sueltos de día reubicados', mov, '· mantienen su día', f'{100 * igual / len(visita):.1f}%')
res = {}
dia0 = dia.copy()
for N in ESC:
    dia = dia0
    zona = emparejar([zonas_del_dia(d, N) for d in range(5)], N)
    zona, dia, mov = limpiar_islas(zona, dia0, max_chica=3, max_lejos=10)
    # volver a emparejar los pedazos ya limpios para que los totales de la semana queden parejos
    zona = emparejar([zona] * 5, N)
    igual = sum(1 for r in visita if DIA_G.get(r['codigo']) == dia[cm[r['codigo']]])
    print(N, 'clientes de pedazos sueltos reubicados', mov, '· mantienen su día', f'{100 * igual / len(visita):.1f}%')
    cz = collections.Counter(); cd = collections.Counter()
    for i in range(n): cz[zona[i]] += peso[i]; cd[(zona[i], dia[i])] += peso[i]
    por_dia = [[cd[(z, d)] for z in range(N)] for d in range(5)]
    print(N, 'zonas', min(cz.values()), max(cz.values()), 'por día (mín-máx dentro de cada día)', [f'{min(x)}-{max(x)}' for x in por_dia])
    res[N] = [[int(zona[i]) + 1, int(dia[i]) + 1] for i in range(n)]

# Recupero: zonas para 4 vendedores nuevos que salen a levantar los telefónicos (700 y otros), con los
# mismos días por sector que los clientes con venta. Se guarda como escenario 4.
REC = 4
peso = np.zeros(n, int)
tel = [r for r in cli if r['estado'].startswith('Telefónico')]
for r in tel: peso[cm[r['codigo']]] += 1
dia = dia0
zona = emparejar([zonas_del_dia(d, REC) for d in range(5)], REC)
zona, dia, mov = limpiar_islas(zona, dia0, max_chica=3, max_lejos=10)
zona = emparejar([zona] * 5, REC)
igual = sum(1 for r in tel if DIA_G.get(r['codigo']) == dia[cm[r['codigo']]])
cz = collections.Counter(); cd = collections.Counter()
for i in range(n): cz[zona[i]] += peso[i]; cd[(zona[i], dia[i])] += peso[i]
print('recupero', len(tel), 'telefónicos ·', REC, 'zonas', sorted(cz.values()), '· por día', [[cd[(z, d)] for d in range(5)] for z in range(REC)],
      f'· coinciden con su día del maestro {100 * igual / len(tel):.0f}%')
res[REC] = [[int(zona[i]) + 1, int(dia[i]) + 1] for i in range(n)]
json.dump(res, open('asignacion.json', 'w'), separators=(',', ':'))
