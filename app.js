// MAS Zonas: zonas y días de visita por manzana. Cada manzana tiene una zona (vendedor) y un día;
// los bordes son calles porque las manzanas salen de las calles de OpenStreetMap.
(function () {
  const DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'];
  const COL_DIA = ['#2b6cb0', '#dd6b20', '#2f855a', '#c53030', '#805ad5'];
  const COL_ZONA = ['#4f8ef7', '#f7614f', '#3fb67e', '#c74fa8', '#e6a817', '#17a2b8', '#a0522d', '#7b4fc7', '#d94f6b', '#2e7d32',
    '#ff8f00', '#5c6bc0', '#8d6e63', '#00897b', '#c0ca33', '#6d4c41', '#ec407a', '#26a69a', '#7e57c2', '#9e9d24'];
  const LOCAL = new URLSearchParams(location.search).has('local');
  const $ = s => document.querySelector(s);
  const num = x => Math.round(x).toLocaleString('es-AR');

  let sb = null, usuario = null;
  let man = [], clientes = [], porManzana = [], peso = null, telPorManzana = [];
  let escenarios = [], esc = 0;
  const asig = {};            // esc -> { zona: Int16Array, dia: Int8Array }
  const pendientes = {};      // esc -> Map(manzana -> [zona, dia])
  const historial = [];       // [{esc, cambios: [[m, zonaAntes, diaAntes, zonaDesp, diaDesp]]}]
  let vista = 'dias', diaSel = 0, zonaSel = 1, destino = null, herramienta = 'mover';
  let map, capa, segs, bordesCache = null;

  // ---------- Carga ----------
  async function iniciar() {
    if (LOCAL) return cargar();
    sb = window.supabase.createClient(MAS_CONFIG.SUPABASE_URL, MAS_CONFIG.SUPABASE_ANON_KEY);
    const { data } = await sb.auth.getSession();
    if (data.session) { usuario = data.session.user; return cargar(); }
    $('#cargando').hidden = true; $('#login').hidden = false;
  }
  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#login-error'); err.hidden = true;
    const { data, error } = await sb.auth.signInWithPassword({ email: $('#login-email').value.trim(), password: $('#login-pass').value });
    if (error) { err.textContent = 'Usuario o contraseña incorrectos.'; err.hidden = false; return; }
    usuario = data.user; $('#login').hidden = true; $('#cargando').hidden = false; cargar();
  });
  $('#btn-salir').addEventListener('click', async () => {
    if (contarPendientes() && !confirm('Hay cambios sin guardar. ¿Salir igual?')) return;
    if (sb) await sb.auth.signOut();
    location.reload();
  });

  async function traerTodo(tabla, cols, filtro) {
    const filas = []; const paso = 1000;
    for (let desde = 0; ; desde += paso) {
      let q = sb.from(tabla).select(cols).range(desde, desde + paso - 1);
      if (filtro) q = filtro(q);
      const { data, error } = await q;
      if (error) throw error;
      filas.push(...data);
      if (data.length < paso) return filas;
    }
  }

  async function cargarAsignacion(e) {
    if (asig[e]) return;
    const zona = new Int16Array(man.length), dia = new Int8Array(man.length);
    if (LOCAL) {
      const a = window._localAsig[e];
      a.forEach(([z, d], i) => { zona[i] = z; dia[i] = d; });
    } else {
      const filas = await traerTodo('zonas_asignacion', 'manzana,zona,dia', q => q.eq('escenario', e).order('manzana'));
      for (const f of filas) { zona[f.manzana] = f.zona; dia[f.manzana] = f.dia; }
    }
    asig[e] = { zona, dia };
  }

  async function cargar() {
    try {
      man = await (await fetch('manzanas.json')).json();
      if (LOCAL) {
        clientes = await (await fetch('datos/local/clientes.json')).json();
        window._localAsig = await (await fetch('datos/local/asignacion.json')).json();
        escenarios = Object.keys(window._localAsig).map(Number).sort((a, b) => b - a);
      } else {
        clientes = await traerTodo('zonas_clientes', 'codigo,cliente,vendedor,segmento,fact_mes,estado,lat,lng,manzana');
        const { data, error } = await sb.from('zonas_asignacion').select('escenario').eq('manzana', 0);
        if (error) throw error;
        escenarios = data.map(r => r.escenario).sort((a, b) => b - a);
      }
      esc = escenarios[0];
      await cargarAsignacion(esc);
      prepararDatos();
      $('#cargando').hidden = true; $('#app').hidden = false;
      armarMapa(); armarControles(); desdeLink(); refrescar();
    } catch (e) {
      $('#cargando').textContent = 'No se pudo cargar: ' + (e.message || e);
    }
  }

  // ---------- Datos derivados ----------
  const mx = lon => (lon + 180) / 360 * 256;
  const my = lat => { const s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256; };

  function prepararDatos() {
    peso = new Int32Array(man.length);
    porManzana = man.map(() => []);
    telPorManzana = new Int32Array(man.length);
    for (const c of clientes) {
      c.wx = mx(c.lng); c.wy = my(c.lat);
      porManzana[c.manzana].push(c);
      if (c.estado === 'Visita') peso[c.manzana]++; else if (c.estado.startsWith('Telefónico')) telPorManzana[c.manzana]++;
    }
    // geometría en coordenadas de mundo (zoom 0) + caja de cada manzana
    const segMap = new Map();
    for (const m of man) {
      const pts = m.r.map(([lo, la]) => [mx(lo), my(la)]);
      m.p = new Path2D(); m.box = [Infinity, Infinity, -Infinity, -Infinity];
      pts.forEach(([x, y], i) => {
        i ? m.p.lineTo(x, y) : m.p.moveTo(x, y);
        m.box[0] = Math.min(m.box[0], x); m.box[1] = Math.min(m.box[1], y); m.box[2] = Math.max(m.box[2], x); m.box[3] = Math.max(m.box[3], y);
      });
      m.p.closePath(); m.pts = pts;
      for (let i = 0; i + 1 < m.r.length; i++) {
        const a = m.r[i].join(','), b = m.r[i + 1].join(',');
        const k = a < b ? a + '|' + b : b + '|' + a;
        const s = segMap.get(k);
        if (s) s.m2 = m.id; else segMap.set(k, { m1: m.id, m2: -1, a: pts[i], b: pts[i + 1], ka: m.r[i], kb: m.r[i + 1] });
      }
    }
    segs = [...segMap.values()];
    // índice en grilla para encontrar la manzana bajo el cursor
    window._grilla = new Map();
    const G = 0.002;
    man.forEach(m => {
      for (let gx = Math.floor(m.box[0] / G); gx <= Math.floor(m.box[2] / G); gx++)
        for (let gy = Math.floor(m.box[1] / G); gy <= Math.floor(m.box[3] / G); gy++) {
          const k = gx + ',' + gy; if (!_grilla.has(k)) _grilla.set(k, []); _grilla.get(k).push(m.id);
        }
    });
    window._G = G;
  }

  function manzanaEn(wx, wy) {
    const l = _grilla.get(Math.floor(wx / _G) + ',' + Math.floor(wy / _G)) || [];
    for (const id of l) {
      const m = man[id];
      if (wx < m.box[0] || wx > m.box[2] || wy < m.box[1] || wy > m.box[3]) continue;
      if (dentroDe(m.pts, wx, wy)) return id;
    }
    return -1;
  }
  function dentroDe(P, x, y) {
    let c = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      if ((P[i][1] > y) !== (P[j][1] > y) && x < (P[j][0] - P[i][0]) * (y - P[i][1]) / (P[j][1] - P[i][1]) + P[i][0]) c = !c;
    }
    return c;
  }

  // ---------- Grupos según la vista ----------
  // grupo de una manzana: lo que la colorea y lo que se pinta
  function grupo(id) {
    const A = asig[esc];
    if (vista === 'dias') return A.dia[id];
    if (vista === 'zonasDia') return A.dia[id] === diaSel + 1 ? A.zona[id] : 0;
    return A.zona[id] === zonaSel ? A.dia[id] : 0;
  }
  function colorGrupo(g) {
    if (!g) return null;
    return vista === 'zonasDia' ? COL_ZONA[(g - 1) % COL_ZONA.length] : COL_DIA[g - 1];
  }
  const nZonas = () => esc;

  // ---------- Mapa ----------
  function armarMapa() {
    map = L.map('mapa', { zoomAnimation: false, preferCanvas: true, zoomSnap: 0.5 }).setView([-31.42, -64.19], 12);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, attribution: 'Mapa © Esri · Calles © OpenStreetMap',
    }).addTo(map);
    const Capa = L.Layer.extend({
      onAdd(m) {
        this.cv = L.DomUtil.create('canvas', 'capa-zonas'); this.cv.style.position = 'absolute'; this.cv.style.pointerEvents = 'none';
        m.getPanes().overlayPane.appendChild(this.cv);
        m.on('move zoom resize viewreset', this.dibujar, this); this.dibujar();
      },
      onRemove(m) { this.cv.remove(); m.off('move zoom resize viewreset', this.dibujar, this); },
      dibujar() { dibujar(this.cv); },
    });
    capa = new Capa().addTo(map);
    const pts = clientes.filter(c => c.estado === 'Visita');
    map.fitBounds(L.latLngBounds(pts.map(c => [c.lat, c.lng])), { padding: [20, 20] });
    eventosPincel();
  }

  function transformacion() {
    const z = map.getZoom(), k = 2 ** z;
    const o = map.getPixelBounds().min;
    return { k, ox: -o.x, oy: -o.y };
  }

  function dibujar(cv) {
    if (!map) return;
    const size = map.getSize(), dpr = window.devicePixelRatio || 1;
    cv.width = size.x * dpr; cv.height = size.y * dpr; cv.style.width = size.x + 'px'; cv.style.height = size.y + 'px';
    L.DomUtil.setPosition(cv, map.containerPointToLayerPoint([0, 0]));
    const ctx = cv.getContext('2d');
    const { k, ox, oy } = transformacion();
    const vx0 = -ox / k, vy0 = -oy / k, vx1 = (size.x - ox) / k, vy1 = (size.y - oy) / k;
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * ox, dpr * oy);
    const otras = $('#ck-otras').checked;
    // relleno por color
    const porColor = new Map();
    for (const m of man) {
      if (m.box[2] < vx0 || m.box[0] > vx1 || m.box[3] < vy0 || m.box[1] > vy1) continue;
      const g = grupo(m.id);
      let col = colorGrupo(g);
      if (!col) { if (!otras) continue; col = '#9aa3b5'; }
      const key = col + (peso[m.id] ? '' : '|vacia');
      if (!porColor.has(key)) porColor.set(key, []);
      porColor.get(key).push(m);
    }
    // las manzanas sin clientes van más claras: solo marcan hasta dónde llega cada parte
    for (const [key, ms] of porColor) {
      const [col, vacia] = key.split('|');
      ctx.fillStyle = col; ctx.globalAlpha = col === '#9aa3b5' ? 0.1 : vacia ? 0.16 : 0.45;
      for (const m of ms) ctx.fill(m.p);
    }
    ctx.globalAlpha = 1;
    // bordes: entre zonas distintas (fino) y entre días distintos (grueso) según la vista
    const A = asig[esc];
    const finos = new Path2D(), gruesos = new Path2D();
    for (const s of segs) {
      const x0 = Math.min(s.a[0], s.b[0]), x1 = Math.max(s.a[0], s.b[0]), y0 = Math.min(s.a[1], s.b[1]), y1 = Math.max(s.a[1], s.b[1]);
      if (x1 < vx0 || x0 > vx1 || y1 < vy0 || y0 > vy1) continue;
      const g1 = grupo(s.m1), g2 = s.m2 >= 0 ? grupo(s.m2) : 0;
      if (g1 !== g2 && (g1 || g2)) { gruesos.moveTo(s.a[0], s.a[1]); gruesos.lineTo(s.b[0], s.b[1]); }
      else if (vista === 'dias' && s.m2 >= 0 && A.zona[s.m1] !== A.zona[s.m2] && g1) { finos.moveTo(s.a[0], s.a[1]); finos.lineTo(s.b[0], s.b[1]); }
    }
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(20,33,61,.55)'; ctx.lineWidth = 1 / k; ctx.stroke(finos);
    ctx.strokeStyle = '#14213d'; ctx.lineWidth = 2.4 / k; ctx.stroke(gruesos);
    // clientes
    const verCli = $('#ck-cli').checked, ver700 = $('#ck-tel700').checked, verD = $('#ck-telD').checked;
    const r = Math.max(1.6, Math.min(4.5, (map.getZoom() - 10) * 0.9)) / k;
    for (const c of clientes) {
      if (c.wx < vx0 || c.wx > vx1 || c.wy < vy0 || c.wy > vy1) continue;
      const vis = c.estado === 'Visita';
      const t700 = c.estado === 'Telefónico (camión 700)', tD = c.estado === 'Telefónico';
      if (vis ? !verCli : !((ver700 && t700) || (verD && tD))) continue;
      if (vis && vista !== 'dias' && !grupo(c.manzana) && !otras) continue;
      ctx.beginPath(); ctx.arc(c.wx, c.wy, r, 0, Math.PI * 2);
      ctx.fillStyle = vis ? (colorGrupo(grupo(c.manzana)) || '#6b7280') : t700 ? '#111' : '#7c3aed';
      ctx.fill(); ctx.lineWidth = r * 0.45; ctx.strokeStyle = '#fff'; ctx.stroke();
    }
    // etiquetas
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '700 12px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const e of etiquetas()) {
      const X = e.x * k + ox, Y = e.y * k + oy;
      if (X < -40 || Y < -20 || X > size.x + 40 || Y > size.y + 20) continue;
      const w = ctx.measureText(e.t).width + 12;
      ctx.fillStyle = e.c; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.roundRect(X - w / 2, Y - 10, w, 20, 10); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.fillText(e.t, X, Y);
    }
  }

  // centro de cada (zona, día) con clientes, para las etiquetas
  function etiquetas() {
    const A = asig[esc], acc = new Map();
    for (const c of clientes) {
      if (c.estado !== 'Visita') continue;
      const id = c.manzana, z = A.zona[id], d = A.dia[id];
      const key = vista === 'dias' ? z + '-' + d : vista === 'zonasDia' ? (d === diaSel + 1 ? 'z' + z : null) : (z === zonaSel ? 'd' + d : null);
      if (!key) continue;
      const a = acc.get(key) || { x: 0, y: 0, n: 0, z, d }; a.x += c.wx; a.y += c.wy; a.n++; acc.set(key, a);
    }
    return [...acc.values()].map(a => ({
      x: a.x / a.n, y: a.y / a.n,
      t: vista === 'dias' ? `Z${a.z}` : vista === 'zonasDia' ? `Z${a.z}` : DIAS[a.d - 1].slice(0, 3),
      c: vista === 'zonasDia' ? COL_ZONA[(a.z - 1) % COL_ZONA.length] : COL_DIA[a.d - 1],
    }));
  }

  // ?vista=zonasDia&dia=2&zona=3&ver=-31.42,-64.19,15 abre directo en esa vista y lugar
  function desdeLink() {
    const q = new URLSearchParams(location.search);
    if (['dias', 'zonasDia', 'zona'].includes(q.get('vista'))) vista = q.get('vista');
    if (q.get('dia')) diaSel = Math.min(4, Math.max(0, Number(q.get('dia')) - 1));
    if (q.get('zona')) zonaSel = Number(q.get('zona')) || 1;
    $('#sel-dia').value = diaSel; $('#sel-zona').value = zonaSel;
    const v = (q.get('ver') || '').split(',').map(Number);
    if (v.length === 3 && v.every(Number.isFinite)) map.setView([v[0], v[1]], v[2]);
  }

  // ---------- Pintar ----------
  let trazo = null;
  function aplicar(id) {
    if (id < 0 || destino == null) return;
    const A = asig[esc];
    let z = A.zona[id], d = A.dia[id];
    if (vista === 'dias') d = destino;
    else if (vista === 'zonasDia') { z = destino; d = diaSel + 1; }
    else { z = zonaSel; d = destino; }
    if (z === A.zona[id] && d === A.dia[id]) return;
    trazo.push([id, A.zona[id], A.dia[id], z, d]);
    A.zona[id] = z; A.dia[id] = d;
    if (!pendientes[esc]) pendientes[esc] = new Map();
    pendientes[esc].set(id, [z, d]);
  }
  function cerrarTrazo() {
    if (trazo && trazo.length) historial.push({ esc, cambios: trazo });
    trazo = null; refrescar();
  }
  function eventosPincel() {
    const cont = map.getContainer();
    let lazo = null;
    const mundo = e => { const p = map.mouseEventToContainerPoint(e); const { k, ox, oy } = transformacion(); return [(p.x - ox) / k, (p.y - oy) / k]; };
    cont.addEventListener('pointerdown', e => {
      if (herramienta === 'mover' || e.button !== 0 || e.target.closest('.leaflet-control')) return;
      if (destino == null) { estado('Elegí primero con qué pintar.'); return; }
      e.preventDefault(); cont.setPointerCapture(e.pointerId);
      if (herramienta === 'pincel') { trazo = []; aplicar(manzanaEn(...mundo(e))); capa.dibujar(); }
      else lazo = [mundo(e)];
    });
    cont.addEventListener('pointermove', e => {
      if (trazo && herramienta === 'pincel') { aplicar(manzanaEn(...mundo(e))); capa.dibujar(); }
      else if (lazo) { lazo.push(mundo(e)); dibujarLazo(lazo); }
    });
    const fin = e => {
      if (trazo && herramienta === 'pincel') cerrarTrazo();
      if (lazo) {
        trazo = [];
        if (lazo.length > 2) {
          const xs = lazo.map(p => p[0]), ys = lazo.map(p => p[1]);
          const b = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
          for (const m of man) {
            if (m.box[2] < b[0] || m.box[0] > b[2] || m.box[3] < b[1] || m.box[1] > b[3]) continue;
            const cx = (m.box[0] + m.box[2]) / 2, cy = (m.box[1] + m.box[3]) / 2;
            if (dentroDe(lazo, cx, cy)) aplicar(m.id);
          }
        }
        lazo = null; quitarLazo(); cerrarTrazo();
      }
    };
    cont.addEventListener('pointerup', fin); cont.addEventListener('pointercancel', fin);
    map.on('click', e => {
      if (herramienta !== 'mover') return;
      const id = manzanaEn(mx(e.latlng.lng), my(e.latlng.lat));
      mostrarInfo(id, e.latlng);
    });
  }
  let lazoLinea = null;
  function dibujarLazo(l) {
    const ll = l.map(([x, y]) => map.unproject([x, y], 0));
    if (!lazoLinea) lazoLinea = L.polyline(ll, { color: '#14213d', weight: 2, dashArray: '4 4', interactive: false }).addTo(map);
    else lazoLinea.setLatLngs(ll);
  }
  function quitarLazo() { if (lazoLinea) { lazoLinea.remove(); lazoLinea = null; } }

  function mostrarInfo(id, latlng) {
    const box = $('#info');
    if (id < 0) { box.hidden = true; return; }
    const A = asig[esc];
    const cs = porManzana[id];
    box.textContent = '';
    const add = (t, b) => { const el = document.createElement(b ? 'b' : 'div'); el.textContent = t; box.appendChild(el); };
    add(`Zona ${A.zona[id]} · ${DIAS[A.dia[id] - 1]}`, true);
    add(`${peso[id]} clientes de visita${telPorManzana[id] ? ` · ${telPorManzana[id]} telefónicos` : ''}`);
    for (const c of cs.slice(0, 8)) add(`#${c.codigo} ${c.cliente} · V${c.vendedor}${c.estado === 'Visita' ? '' : ' · ' + c.estado.toLowerCase()}`);
    if (cs.length > 8) add(`y ${cs.length - 8} más`);
    box.hidden = false;
  }

  // ---------- Controles ----------
  function armarControles() {
    const eb = $('#esc-btns');
    for (const e of escenarios) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = `${e} vendedores`; b.dataset.esc = e;
      b.addEventListener('click', async () => { estado('Cargando…'); await cargarAsignacion(e); esc = e; destino = null; estado(''); armarSelects(); refrescar(); });
      eb.appendChild(b);
    }
    document.querySelectorAll('[data-vista]').forEach(b => b.addEventListener('click', () => { vista = b.dataset.vista; destino = null; refrescar(); if (vista === 'zona') encuadrarZona(); }));
    document.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => { herramienta = b.dataset.tool; refrescar(); }));
    $('#sel-dia').addEventListener('change', e => { diaSel = Number(e.target.value); destino = null; refrescar(); });
    $('#sel-zona').addEventListener('change', e => { zonaSel = Number(e.target.value); destino = null; refrescar(); encuadrarZona(); });
    ['#ck-cli', '#ck-tel700', '#ck-telD', '#ck-otras'].forEach(s => $(s).addEventListener('change', () => capa.dibujar()));
    $('#btn-deshacer').addEventListener('click', deshacer);
    $('#btn-guardar').addEventListener('click', guardar);
    $('#btn-kml').addEventListener('click', exportarKML);
    $('#btn-csv').addEventListener('click', exportarCSV);
    $('#buscar').addEventListener('input', buscar);
    document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); deshacer(); } });
    window.addEventListener('beforeunload', e => { if (contarPendientes()) { e.preventDefault(); e.returnValue = ''; } });
    const sd = $('#sel-dia'); DIAS.forEach((d, i) => sd.appendChild(new Option(d, i)));
    armarSelects();
  }
  // acerca el mapa a los clientes de la zona elegida
  function encuadrarZona() {
    const A = asig[esc];
    const pts = clientes.filter(c => c.estado === 'Visita' && A.zona[c.manzana] === zonaSel).map(c => [c.lat, c.lng]);
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
  }
  function armarSelects() {
    const sz = $('#sel-zona'); sz.textContent = '';
    for (let z = 1; z <= nZonas(); z++) sz.appendChild(new Option('Zona ' + z, z));
    if (zonaSel > nZonas()) zonaSel = 1;
    sz.value = zonaSel;
  }

  function conteos() {
    const A = asig[esc], c = new Map(), f = new Map(), tot = new Map();
    for (const cl of clientes) {
      if (cl.estado !== 'Visita') continue;
      const id = cl.manzana, g = grupo(id);
      tot.set(A.zona[id], (tot.get(A.zona[id]) || 0) + 1);
      if (!g) continue;
      c.set(g, (c.get(g) || 0) + 1); f.set(g, (f.get(g) || 0) + (cl.fact_mes || 0));
    }
    return { c, f, tot };
  }

  function refrescar() {
    document.querySelectorAll('[data-esc]').forEach(b => b.setAttribute('aria-pressed', Number(b.dataset.esc) === esc));
    document.querySelectorAll('[data-vista]').forEach(b => b.setAttribute('aria-pressed', b.dataset.vista === vista));
    document.querySelectorAll('[data-tool]').forEach(b => b.setAttribute('aria-pressed', b.dataset.tool === herramienta));
    $('#sel-dia').hidden = vista !== 'zonasDia';
    $('#sel-zona').hidden = vista !== 'zona';
    map.dragging[herramienta === 'mover' ? 'enable' : 'disable']();
    $('#mapa').classList.toggle('pincel', herramienta !== 'mover');
    $('#ayuda-tool').textContent = herramienta === 'mover' ? 'Arrastrá para moverte. Tocá una manzana para ver su zona, día y clientes.'
      : herramienta === 'pincel' ? 'Arrastrá sobre las manzanas para pasarlas a lo elegido abajo. Ctrl+Z deshace.'
        : 'Dibujá un contorno: todas las manzanas de adentro pasan a lo elegido abajo.';
    // destinos con conteos
    const { c, f, tot } = conteos();
    const box = $('#destinos'); box.textContent = '';
    let items = [];
    if (vista === 'dias') { $('#destino-tit').textContent = 'Días (clientes de visita)'; items = DIAS.map((d, i) => ({ g: i + 1, t: d })); }
    else if (vista === 'zonasDia') { $('#destino-tit').textContent = `Zonas del ${DIAS[diaSel].toLowerCase()}`; for (let z = 1; z <= nZonas(); z++) items.push({ g: z, t: `Zona ${z}`, extra: `${num(tot.get(z) || 0)} en la semana` }); }
    else { $('#destino-tit').textContent = `Días de la zona ${zonaSel} · ${num(tot.get(zonaSel) || 0)} clientes`; items = DIAS.map((d, i) => ({ g: i + 1, t: d })); }
    const vals = items.map(it => c.get(it.g) || 0), prom = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
    for (const it of items) {
      const d = document.createElement('div');
      const n = c.get(it.g) || 0;
      d.className = 'dest' + (destino === it.g ? ' sel' : '') + (vista !== 'dias' && n > prom * 1.12 ? ' alto' : '');
      const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = colorGrupo(it.g);
      const t = document.createElement('span'); t.textContent = it.t;
      if (it.extra) { const s = document.createElement('small'); s.className = 'f'; s.textContent = ' · ' + it.extra; t.appendChild(s); }
      const nn = document.createElement('span'); nn.className = 'n'; nn.textContent = num(n);
      const ff = document.createElement('span'); ff.className = 'f'; ff.textContent = '$ ' + num((f.get(it.g) || 0) / 1000) + ' mil';
      d.append(dot, t, nn, ff);
      d.addEventListener('click', () => { destino = destino === it.g ? null : it.g; if (destino != null && herramienta === 'mover') herramienta = 'pincel'; refrescar(); });
      box.appendChild(d);
    }
    const np = contarPendientes();
    $('#btn-guardar').disabled = !np || LOCAL;
    $('#btn-guardar').textContent = np ? `Guardar (${np})` : 'Guardar';
    $('#btn-deshacer').disabled = !historial.length;
    if (LOCAL && np) estado('Modo local: los cambios no se guardan.');
    capa && capa.dibujar();
  }
  const contarPendientes = () => Object.values(pendientes).reduce((a, m) => a + m.size, 0);
  const estado = t => { $('#estado').textContent = t; };

  function deshacer() {
    const h = historial.pop(); if (!h) return;
    const A = asig[h.esc];
    for (let i = h.cambios.length - 1; i >= 0; i--) {
      const [id, z0, d0] = h.cambios[i];
      A.zona[id] = z0; A.dia[id] = d0;
      pendientes[h.esc].set(id, [z0, d0]);
    }
    refrescar();
  }

  async function guardar() {
    const btn = $('#btn-guardar'); btn.disabled = true; estado('Guardando…');
    try {
      for (const [e, m] of Object.entries(pendientes)) {
        const cambios = [...m].map(([manzana, [zona, dia]]) => ({ manzana, zona, dia }));
        for (let i = 0; i < cambios.length; i += 2000) {
          const { error } = await sb.rpc('zonas_guardar', { p_escenario: Number(e), p_cambios: cambios.slice(i, i + 2000) });
          if (error) throw error;
        }
        m.clear();
      }
      estado('Guardado ' + new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) + '.');
    } catch (e) { estado('No se pudo guardar: ' + (e.message || e)); }
    refrescar();
  }

  function buscar() {
    const q = $('#buscar').value.trim().toLowerCase(), box = $('#resultados'); box.textContent = '';
    if (q.length < 2) return;
    for (const c of clientes.filter(c => c.codigo === q || c.cliente.toLowerCase().includes(q)).slice(0, 8)) {
      const b = document.createElement('button'); b.type = 'button';
      const A = asig[esc];
      b.textContent = `#${c.codigo} ${c.cliente} · zona ${A.zona[c.manzana]} · ${DIAS[A.dia[c.manzana] - 1].toLowerCase()}`;
      b.addEventListener('click', () => { map.setView([c.lat, c.lng], 17); mostrarInfo(c.manzana); });
      box.appendChild(b);
    }
  }

  // ---------- Exportar ----------
  // anillos del contorno de un conjunto de manzanas: tramos de calle con una sola cara adentro
  function contornos(dentro) {
    const sig = new Map(); const clave = p => p[0] + ',' + p[1];
    for (const s of segs) {
      const a = dentro(s.m1), b = s.m2 >= 0 && dentro(s.m2);
      if (a === b) continue;
      const [p, q] = a ? [s.ka, s.kb] : [s.kb, s.ka];
      const k = clave(p); if (!sig.has(k)) sig.set(k, []); sig.get(k).push(q);
    }
    const anillos = [];
    for (const [k0] of sig) {
      while (sig.get(k0) && sig.get(k0).length) {
        const ring = []; let k = k0, p = k0.split(',').map(Number);
        for (let guard = 0; guard < 1e6; guard++) {
          ring.push(p);
          const l = sig.get(k); if (!l || !l.length) break;
          const q = l.pop(); k = clave(q); p = q;
          if (k === k0) { ring.push(p); break; }
        }
        if (ring.length > 3) anillos.push(ring);
      }
    }
    return anillos;
  }
  function descargar(nombre, texto, tipo) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([texto], { type: tipo })); a.download = nombre; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function exportarKML() {
    const A = asig[esc], grupos = [];
    if (vista === 'zona') DIAS.forEach((d, i) => grupos.push({ n: `Zona ${zonaSel} - ${d}`, f: id => A.zona[id] === zonaSel && A.dia[id] === i + 1, c: COL_DIA[i] }));
    else if (vista === 'zonasDia') for (let z = 1; z <= nZonas(); z++) grupos.push({ n: `Zona ${z} - ${DIAS[diaSel]}`, f: id => A.zona[id] === z && A.dia[id] === diaSel + 1, c: COL_ZONA[(z - 1) % COL_ZONA.length] });
    else for (let z = 1; z <= nZonas(); z++) for (let d = 1; d <= 5; d++) grupos.push({ n: `Zona ${z} - ${DIAS[d - 1]}`, f: id => A.zona[id] === z && A.dia[id] === d, c: COL_DIA[d - 1] });
    const kmlCol = h => 'aa' + h.slice(5, 7) + h.slice(3, 5) + h.slice(1, 3);
    let pm = '';
    for (const g of grupos) {
      const rings = contornos(g.f); if (!rings.length) continue;
      pm += `<Placemark><name>${g.n}</name><Style><LineStyle><color>ff${kmlCol(g.c).slice(2)}</color><width>2</width></LineStyle><PolyStyle><color>${kmlCol(g.c).replace(/^aa/, '55')}</color></PolyStyle></Style><MultiGeometry>`
        + rings.map(r => `<Polygon><outerBoundaryIs><LinearRing><coordinates>${r.map(p => p[0] + ',' + p[1]).join(' ')}</coordinates></LinearRing></outerBoundaryIs></Polygon>`).join('')
        + '</MultiGeometry></Placemark>\n';
    }
    descargar(`zonas_${esc}_vendedores.kml`, `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Zonas ${esc} vendedores</name>\n${pm}</Document></kml>`, 'application/vnd.google-earth.kml+xml');
  }
  function exportarCSV() {
    const A = asig[esc];
    const esc_ = v => /[",;\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v;
    const filas = [['codigo', 'cliente', 'vendedor_actual', 'segmento', 'estado', 'fact_mes', 'zona', 'dia']];
    for (const c of clientes) filas.push([c.codigo, c.cliente, c.vendedor, c.segmento, c.estado, Math.round(c.fact_mes), A.zona[c.manzana], DIAS[A.dia[c.manzana] - 1]]);
    descargar(`clientes_zonas_${esc}_vendedores.csv`, '﻿' + filas.map(f => f.map(esc_).join(';')).join('\n'), 'text/csv');
  }

  iniciar();
})();
