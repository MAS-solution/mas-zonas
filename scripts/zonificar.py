# Zonas y días por manzana para cada escenario. Una zona = manzanas enteras (los bordes son calles).
# Los días se respetan: cada manzana queda con el día que la mayoría de sus clientes ya tiene en la ruta
# de Gescom (dias_gescom.json; los de sábado toman el día de sus vecinos). Las zonas se arman alrededor
# de eso: crecen por calles desde N centros (los de las zonas del reporte) y cada una junta la misma
# cantidad de clientes de cada día, así cada vendedor tiene ~1/5 de su zona por día.
import json, csv, math, collections
import numpy as np

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

def zonas_del_dia(d, N):
    """Parte las manzanas del día d en N subzonas compactas y parejas (cortes rectos y después ajuste por calles)."""
    global selset
    idx = np.where(dia == d)[0]
    con = idx[peso[idx] > 0]
    lab = np.full(n, -1)
    for k, parte in enumerate(biseccion(con, N, peso)): lab[parte] = k
    dentro = np.zeros(n, bool); dentro[idx] = True
    lab = rellenar(lab, dentro)
    selset = set(idx.tolist())
    lab = equilibrar(lab, N, con.tolist(), tol=2)
    l2 = lab.copy(); l2[idx[peso[idx] == 0]] = -1
    l2 = rellenar(l2, dentro)
    # numerar por ángulo alrededor del centro, así la zona k de cada día cae para el mismo lado
    ang = []
    for k in range(N):
        ii = idx[(l2[idx] == k) & (peso[idx] > 0)]
        c = np.average(cxy[ii], axis=0, weights=peso[ii]) - CENTRO
        ang.append(np.arctan2(c[1], c[0]))
    orden = {k: r for r, k in enumerate(np.argsort(ang))}
    out = np.full(n, -1)
    out[idx] = [orden[k] for k in l2[idx]]
    return out

res = {}
for N in ESC:
    zona = np.full(n, -1)
    for d in range(5):
        zd = zonas_del_dia(d, N); m = zd >= 0; zona[m] = zd[m]
    cz = collections.Counter(); cd = collections.Counter()
    for i in range(n): cz[zona[i]] += peso[i]; cd[(zona[i], dia[i])] += peso[i]
    print(N, 'zonas', min(cz.values()), max(cz.values()), 'por día', min(cd.values()), max(cd.values()))
    res[N] = [[int(zona[i]) + 1, int(dia[i]) + 1] for i in range(n)]
json.dump(res, open('asignacion.json', 'w'), separators=(',', ':'))
