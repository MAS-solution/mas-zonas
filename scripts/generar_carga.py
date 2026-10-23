# Arma los SQL de carga inicial (clientes + zona/día por manzana de cada escenario) en datos/local/,
# que no se sube al repo porque tiene datos de clientes. Se corren con el sql.py de MAS Recepción.
import json, os
AQUI = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
L = os.path.join(AQUI, 'datos', 'local')
cli = json.load(open(os.path.join(L, 'clientes.json'), encoding='utf-8'))
asig = json.load(open(os.path.join(L, 'asignacion.json')))
q = lambda s: "'" + str(s).replace("'", "''") + "'"
partes = ['truncate public.zonas_clientes;\ninsert into public.zonas_clientes (codigo, cliente, vendedor, segmento, fact_mes, estado, lat, lng, manzana) values\n'
          + ',\n'.join(f"({q(c['codigo'])},{q(c['cliente'])},{q(c['vendedor'])},{q(c['segmento'])},{c['fact_mes']},{q(c['estado'])},{c['lat']},{c['lng']},{c['manzana']})" for c in cli) + ';']
for e, filas in asig.items():
    for i in range(0, len(filas), 6000):
        vals = ',\n'.join(f'({e},{m},{z},{d})' for m, (z, d) in list(enumerate(filas))[i:i + 6000])
        partes.append(('delete from public.zonas_asignacion where escenario = %s;\n' % e if i == 0 else '')
                      + f'insert into public.zonas_asignacion (escenario, manzana, zona, dia) values\n{vals};')
for k, sql in enumerate(partes):
    open(os.path.join(L, f'carga_{k:02d}.sql'), 'w', encoding='utf-8').write(sql)
print(len(partes), 'archivos en datos/local/')
