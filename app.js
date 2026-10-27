// MAS Zonas: zonas y días de visita por manzana. Cada manzana tiene una zona (vendedor) y un día;
// los bordes son calles porque las manzanas salen de las calles de OpenStreetMap.
(function () {
  const DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'];
  const COL_DIA = ['#2b6cb0', '#dd6b20', '#2f855a', '#c53030', '#805ad5'];
  const COL_ZONA = ['#4f8ef7', '#f7614f', '#3fb67e', '#c74fa8', '#e6a817', '#17a2b8', '#a0522d', '#7b4fc7', '#d94f6b', '#2e7d32',
    '#ff8f00', '#5c6bc0', '#8d6e63', '#00897b', '#c0ca33', '#6d4c41', '#ec407a', '#26a69a', '#7e57c2', '#9e9d24'];
  const LOCAL = new URLSearchParams(location.search).has('local');
  // ?modo=recupero: zonas para vendedores nuevos que salen a levantar los telefónicos (escenarios < 10)
  const RECUPERO = new URLSearchParams(location.search).get('modo') === 'recupero';
  const $ = s => document.querySelector(s);
  if (RECUPERO) { $('#ck-tel700').checked = $('#ck-telD').checked = true; $('#ck-cli').checked = false; document.title = 'MAS Zonas · Recupero'; }
  const num = x => Math.round(x).toLocaleString('es-AR');

  let sb = null, usuario = null;
  let man = [], clientes = [], porManzana = [], peso = null, telPorManzana = [];
  let escenarios = [], esc = 0;
  const asig = {};            // esc -> { zona: Int16Array, dia: Int8Array }
  const pendientes = {};      // esc -> Map(manzana -> [zona, dia])
  const historial = [];       // [{esc, cambios: [[m, zonaAntes, diaAntes, zonaDesp, diaDesp]]}]
  let vista = 'dias', diaSel = 0, zonaSel = 1, destino = null, herramienta = 'mover';
  let map, capa, segs, bordesCache = null;
  // telefónicos que se pasan a visita para recuperarlos (valen para todos los escenarios)
  const recup = new Set(); let recGuardado = new Set(), sinTablaRec = false;
  const esTel = c => c.estado.startsWith('Telefónico');
  // los clientes que cuentan en las zonas: de visita (más los recuperados) o, en el modo recupero, los telefónicos tildados
  // en una propuesta de afuera cuentan todos los clientes que la propuesta visita (en la semana elegida)
  const enRuta = c => RECUPERO
    ? (c.estado === 'Telefónico (camión 700)' ? $('#ck-tel700').checked : c.estado === 'Telefónico' && $('#ck-telD').checked)
    : propuesta() ? !!visDe(c) && (!semanaSel || visDe(c).sem.has(semanaSel))
      : c.estado === 'Visita' || recup.has(c.codigo);
  let rutaCapa = null, rutaActual = null;
  // propuesta de afuera: semana(s) del ciclo de 4 y orden de visita de cada cliente (zonas_visitas)
  const visitas = {};         // esc -> Map(codigo -> { sem: Set, orden: {semana: n}, zona, dia })
  let semanaSel = 0;          // 0 = todo el ciclo
  const visDe = c => visitas[esc] && visitas[esc].get(c.codigo);

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
    if (RUTAS_PROPUESTA[e] && !visitas[e]) {
      const filas = LOCAL ? (await (await fetch('datos/local/visitas.json')).json()).map(([codigo, semana, orden, zona, dia]) => ({ codigo, semana, orden, zona, dia }))
        : await traerTodo('zonas_visitas', 'codigo,semana,orden,zona,dia', q => q.eq('escenario', e).order('codigo'));
      const m = new Map();
      for (const f of filas) {
        const v = m.get(f.codigo) || { sem: new Set(), orden: {}, zona: f.zona, dia: f.dia };
        v.sem.add(f.semana); v.orden[f.semana] = f.orden; m.set(f.codigo, v);
      }
      visitas[e] = m;
    }
  }

  async function cargar() {
    try {
      man = await (await fetch('manzanas.json')).json();
      if (LOCAL) {
        clientes = await (await fetch('datos/local/clientes.json')).json();
        window._localAsig = await (await fetch('datos/local/asignacion.json')).json();
        escenarios = Object.keys(window._localAsig).map(Number).filter(e => RECUPERO ? e < 10 : e >= 10).sort((a, b) => RECUPERO ? a - b : (a >= 100) - (b >= 100) || b - a);
      } else {
        clientes = await traerTodo('zonas_clientes', 'codigo,cliente,vendedor,segmento,fact_mes,estado,lat,lng,manzana');
        if (!RECUPERO) {
          try { for (const r of await traerTodo('zonas_recuperar', 'codigo')) recup.add(r.codigo); }
          catch (e) { sinTablaRec = true; }
        }
        recGuardado = new Set(recup);
        const { data, error } = await sb.from('zonas_asignacion').select('escenario').eq('manzana', 0);
        if (error) throw error;
        escenarios = data.map(r => r.escenario).filter(e => RECUPERO ? e < 10 : e >= 10).sort((a, b) => RECUPERO ? a - b : (a >= 100) - (b >= 100) || b - a);
        if (!escenarios.length) throw new Error(RECUPERO ? 'todavía no están cargadas las zonas de recupero' : 'no hay escenarios');
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
      if (RECUPERO ? esTel(c) : c.estado === 'Visita') peso[c.manzana]++;
      if (c.estado.startsWith('Telefónico')) telPorManzana[c.manzana]++;
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
  // Propuestas de afuera (escenario >= 100): zona z = ruta RUTAS_PROPUESTA[e][z - 1]
  const RUTAS_PROPUESTA = { 115: { nombre: 'Propuesta ZZ', rutas: [31, 41, 42, 43, 44, 47, 48, 49, 51, 52, 53, 54, 55, 57, 58] } };
  const propuesta = () => RUTAS_PROPUESTA[esc];
  const nZonas = () => propuesta() ? propuesta().rutas.length : esc;
  // recupero quincenal (escenario 8): zona 2v-1 = vendedor v semana A, zona 2v = semana B
  const quincenal = () => RECUPERO && esc === 8;
  const nomZona = z => quincenal() ? `V${Math.ceil(z / 2)} · semana ${z % 2 ? 'A' : 'B'}` : propuesta() ? `Ruta ${propuesta().rutas[z - 1]}` : `Zona ${z}`;
  const cortoZona = z => quincenal() ? `V${Math.ceil(z / 2)}${z % 2 ? 'A' : 'B'}` : propuesta() ? `R${propuesta().rutas[z - 1]}` : `Z${z}`;
  const nomEsc = e => RECUPERO && e === 8 ? '4 vendedores · quincenal' : RUTAS_PROPUESTA[e] ? RUTAS_PROPUESTA[e].nombre : `${e} vendedores`;

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
    const pts = clientes.filter(enRuta);
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
      const t700 = c.estado === 'Telefónico (camión 700)', tD = c.estado === 'Telefónico';
      // en el modo recupero los telefónicos son los que cuentan y los de visita quedan de fondo en gris
      const prop = !RECUPERO && propuesta();
      const rec = RECUPERO ? enRuta(c) : prop ? enRuta(c) && (t700 || tD) : recup.has(c.codigo), vis = RECUPERO || prop ? enRuta(c) : c.estado === 'Visita' || rec;
      if (prop ? !vis || !verCli : RECUPERO ? !(vis || (verCli && c.estado === 'Visita')) : vis ? !verCli : !((ver700 && t700) || (verD && tD))) continue;
      if (vis && vista !== 'dias' && !grupo(c.manzana) && !otras) continue;
      ctx.beginPath(); ctx.arc(c.wx, c.wy, rec ? r * 1.25 : r, 0, Math.PI * 2);
      ctx.fillStyle = vis ? (colorGrupo(grupo(c.manzana)) || '#6b7280') : c.estado === 'Visita' ? '#9aa3b5' : t700 ? '#111' : '#7c3aed';
      // los telefónicos que cuentan llevan el borde del color de su tipo (negro 700, violeta otros)
      ctx.fill(); ctx.lineWidth = rec ? r * 0.8 : r * 0.45; ctx.strokeStyle = rec ? (t700 ? '#111' : '#7c3aed') : '#fff'; ctx.stroke();
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
      if (!enRuta(c)) continue;
      const id = c.manzana, z = A.zona[id], d = A.dia[id];
      const key = vista === 'dias' ? z + '-' + d : vista === 'zonasDia' ? (d === diaSel + 1 ? 'z' + z : null) : (z === zonaSel ? 'd' + d : null);
      if (!key) continue;
      const a = acc.get(key) || { x: 0, y: 0, n: 0, z, d }; a.x += c.wx; a.y += c.wy; a.n++; acc.set(key, a);
    }
    return [...acc.values()].map(a => ({
      x: a.x / a.n, y: a.y / a.n,
      t: vista === 'zona' ? DIAS[a.d - 1].slice(0, 3) : cortoZona(a.z),
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
      if (herramienta === 'recuperar') { e.preventDefault(); cont.setPointerCapture(e.pointerId); lazo = [mundo(e)]; return; }
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
      if (lazo && herramienta === 'recuperar') { recuperarEn(lazo); lazo = null; quitarLazo(); return; }
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
  // Recuperar: un toque pasa (o saca) el telefónico más cercano; un contorno pasa todos los visibles de adentro
  function recuperarEn(lazo) {
    const { k } = transformacion();
    const visible = c => esTel(c) && (recup.has(c.codigo) || (c.estado === 'Telefónico' ? $('#ck-telD').checked : $('#ck-tel700').checked));
    const cambios = [];
    const xs = lazo.map(p => p[0]), ys = lazo.map(p => p[1]);
    const ancho = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * k;
    if (lazo.length <= 3 || ancho < 8) {
      const [x, y] = lazo[0]; let mejor = null, dm = (12 / k) ** 2;
      for (const c of clientes) {
        if (!visible(c)) continue;
        const d = (c.wx - x) ** 2 + (c.wy - y) ** 2; if (d < dm) { dm = d; mejor = c; }
      }
      if (mejor) cambios.push([mejor.codigo, recup.has(mejor.codigo), !recup.has(mejor.codigo)]);
      else estado('Tocá un punto de telefónico (negro o violeta).');
    } else {
      for (const c of clientes) if (visible(c) && !recup.has(c.codigo) && dentroDe(lazo, c.wx, c.wy)) cambios.push([c.codigo, false, true]);
    }
    if (!cambios.length) { refrescar(); return; }
    for (const [cod, , desp] of cambios) desp ? recup.add(cod) : recup.delete(cod);
    historial.push({ rec: cambios }); refrescar();
  }
  const pendRec = () => ({
    altas: [...recup].filter(c => !recGuardado.has(c)),
    bajas: [...recGuardado].filter(c => !recup.has(c)),
  });

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
    add(`${nomZona(A.zona[id])} · ${DIAS[A.dia[id] - 1]}`, true);
    add(`${peso[id]} clientes de visita${telPorManzana[id] ? ` · ${telPorManzana[id]} telefónicos` : ''}`);
    for (const c of cs.slice(0, 8)) add(`#${c.codigo} ${c.cliente} · V${c.vendedor}${c.estado === 'Visita' ? '' : ' · ' + c.estado.toLowerCase()}${recup.has(c.codigo) ? ' · a recuperar' : ''}`);
    if (cs.length > 8) add(`y ${cs.length - 8} más`);
    box.hidden = false;
  }

  // ---------- Controles ----------
  function armarControles() {
    // lo que es solo de un modo
    document.querySelectorAll('[data-solo]').forEach(el => { el.hidden = el.dataset.solo !== (RECUPERO ? 'recupero' : 'visita'); });
    const ir = $('#ir-modo'), q = new URLSearchParams(location.search);
    RECUPERO ? q.delete('modo') : q.set('modo', 'recupero'); ['vista', 'dia', 'zona'].forEach(k => q.delete(k));
    ir.href = '?' + q.toString(); ir.textContent = RECUPERO ? 'Ir a zonas de visita' : 'Ir a recupero de telefónicos';
    const eb = $('#esc-btns');
    for (const e of escenarios) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = nomEsc(e); b.dataset.esc = e;
      b.addEventListener('click', async () => { estado('Cargando…'); await cargarAsignacion(e); esc = e; destino = null; estado(''); armarSelects(); refrescar(); });
      eb.appendChild(b);
    }
    document.querySelectorAll('[data-vista]').forEach(b => b.addEventListener('click', () => { vista = b.dataset.vista; destino = null; refrescar(); if (vista === 'zona') encuadrarZona(); }));
    document.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => {
      herramienta = b.dataset.tool;
      if (herramienta === 'recuperar' && !$('#ck-tel700').checked && !$('#ck-telD').checked) $('#ck-tel700').checked = $('#ck-telD').checked = true;
      refrescar();
    }));
    $('#sel-dia').addEventListener('change', e => { diaSel = Number(e.target.value); $('#ruta-dia').value = diaSel + 1; destino = null; refrescar(); });
    $('#sel-zona').addEventListener('change', e => { zonaSel = Number(e.target.value); $('#ruta-zona').value = zonaSel; destino = null; refrescar(); encuadrarZona(); });
    ['#ck-cli', '#ck-otras'].forEach(s => $(s).addEventListener('change', () => capa.dibujar()));
    ['#ck-tel700', '#ck-telD'].forEach(s => $(s).addEventListener('change', () => RECUPERO ? refrescar() : capa.dibujar()));
    document.querySelectorAll('[data-sem]').forEach(b => b.addEventListener('click', () => { semanaSel = Number(b.dataset.sem); quitarRuta(); refrescar(); }));
    $('#btn-deshacer').addEventListener('click', deshacer);
    $('#btn-guardar').addEventListener('click', guardar);
    $('#btn-kml').addEventListener('click', exportarKML);
    $('#btn-csv').addEventListener('click', exportarCSV);
    $('#btn-ruta').addEventListener('click', armarRuta);
    $('#ck-orden-prop').addEventListener('change', () => { if (rutaActual) armarRuta(); });
    $('#btn-ruta-csv').addEventListener('click', exportarRuta);
    $('#btn-ruta-quitar').addEventListener('click', quitarRuta);
    const rd = $('#ruta-dia'); DIAS.forEach((d, i) => rd.appendChild(new Option(d, i + 1)));
    $('#buscar').addEventListener('input', buscar);
    document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); deshacer(); } });
    window.addEventListener('beforeunload', e => { if (contarPendientes()) { e.preventDefault(); e.returnValue = ''; } });
    const sd = $('#sel-dia'); DIAS.forEach((d, i) => sd.appendChild(new Option(d, i)));
    armarSelects();
  }
  // acerca el mapa a los clientes de la zona elegida
  function encuadrarZona() {
    const A = asig[esc];
    const pts = clientes.filter(c => enRuta(c) && A.zona[c.manzana] === zonaSel).map(c => [c.lat, c.lng]);
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
  }
  function armarSelects() {
    const sz = $('#sel-zona'); sz.textContent = '';
    for (let z = 1; z <= nZonas(); z++) sz.appendChild(new Option(nomZona(z), z));
    if (zonaSel > nZonas()) zonaSel = 1;
    sz.value = zonaSel;
    const rz = $('#ruta-zona'), ant = Number(rz.value) || zonaSel; rz.textContent = '';
    for (let z = 1; z <= nZonas(); z++) rz.appendChild(new Option(nomZona(z), z));
    rz.value = ant <= nZonas() ? ant : 1;
  }

  function conteos() {
    const A = asig[esc], c = new Map(), f = new Map(), tot = new Map();
    for (const cl of clientes) {
      if (!enRuta(cl)) continue;
      const id = cl.manzana, g = grupo(id);
      tot.set(A.zona[id], (tot.get(A.zona[id]) || 0) + 1);
      if (!g) continue;
      c.set(g, (c.get(g) || 0) + 1); f.set(g, (f.get(g) || 0) + (cl.fact_mes || 0));
    }
    return { c, f, tot };
  }

  function refrescar() {
    document.querySelectorAll('[data-esc]').forEach(b => b.setAttribute('aria-pressed', Number(b.dataset.esc) === esc));
    $('#campo-semana').hidden = RECUPERO || !propuesta();
    $('#ck-orden-prop-l').hidden = RECUPERO || !propuesta() || !semanaSel;
    document.querySelectorAll('[data-sem]').forEach(b => b.setAttribute('aria-pressed', Number(b.dataset.sem) === semanaSel));
    if (propuesta()) $('#sem-ayuda').textContent = semanaSel
      ? `Los clientes que la propuesta visita en la semana ${semanaSel}: semanales, quincenales y mensuales que caen esa semana. Borde negro: telefónicos del 700; violeta: telefónicos otros. La ruta sale en el orden de la propuesta.`
      : 'Todos los clientes de la propuesta, cada uno una vez. Elegí una semana para ver solo los que se visitan esa semana y el recorrido en el orden de la propuesta.';
    document.querySelectorAll('[data-vista]').forEach(b => b.setAttribute('aria-pressed', b.dataset.vista === vista));
    document.querySelectorAll('[data-tool]').forEach(b => b.setAttribute('aria-pressed', b.dataset.tool === herramienta));
    $('#sel-dia').hidden = vista !== 'zonasDia';
    $('#sel-zona').hidden = vista !== 'zona';
    map.dragging[herramienta === 'mover' ? 'enable' : 'disable']();
    $('#mapa').classList.toggle('pincel', herramienta !== 'mover');
    $('#ayuda-tool').textContent = herramienta === 'mover' ? 'Arrastrá para moverte. Tocá una manzana para ver su zona, día y clientes.'
      : herramienta === 'pincel' ? 'Arrastrá sobre las manzanas para pasarlas a lo elegido abajo. Ctrl+Z deshace.'
        : herramienta === 'recuperar' ? 'Tocá un telefónico para pasarlo a visita (o sacarlo), o dibujá un contorno para pasar todos los de adentro. Entran en la zona y el día de su manzana.'
          : 'Dibujá un contorno: todas las manzanas de adentro pasan a lo elegido abajo.';
    // destinos con conteos
    const { c, f, tot } = conteos();
    const box = $('#destinos'); box.textContent = '';
    let items = [];
    if (vista === 'dias') { $('#destino-tit').textContent = RECUPERO ? 'Días (telefónicos)' : propuesta() ? (semanaSel ? `Días (visitas de la semana ${semanaSel})` : 'Días (clientes de la propuesta)') : 'Días (clientes de visita)'; items = DIAS.map((d, i) => ({ g: i + 1, t: d })); }
    else if (vista === 'zonasDia') { $('#destino-tit').textContent = `Zonas del ${DIAS[diaSel].toLowerCase()}`; for (let z = 1; z <= nZonas(); z++) items.push({ g: z, t: nomZona(z), extra: `${num(tot.get(z) || 0)} en ${quincenal() ? 'su semana' : propuesta() ? (semanaSel ? 'la semana ' + semanaSel : 'el ciclo') : 'la semana'}` }); }
    else { $('#destino-tit').textContent = `Días de ${quincenal() || propuesta() ? nomZona(zonaSel).replace('Ruta', 'la ruta') : 'la zona ' + zonaSel} · ${num(tot.get(zonaSel) || 0)} clientes`; items = DIAS.map((d, i) => ({ g: i + 1, t: d })); }
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
    resumenRecuperar();
    const np = contarPendientes();
    $('#btn-guardar').disabled = !np || LOCAL;
    $('#btn-guardar').textContent = np ? `Guardar (${np})` : 'Guardar';
    $('#btn-deshacer').disabled = !historial.length;
    if (LOCAL && np) estado('Modo local: los cambios no se guardan.');
    capa && capa.dibujar();
  }
  const contarPendientes = () => { const p = pendRec(); return Object.values(pendientes).reduce((a, m) => a + m.size, 0) + p.altas.length + p.bajas.length; };

  function resumenRecuperar() {
    if (RECUPERO) return;
    const A = asig[esc]; let n7 = 0, nD = 0, f = 0, enZona = 0;
    for (const c of clientes) {
      if (!recup.has(c.codigo)) continue;
      if (c.estado === 'Telefónico') { nD++; f += c.fact_mes || 0; } else n7++;
      if (A.zona[c.manzana] === zonaSel) enZona++;
    }
    let t = !(n7 + nD) ? 'Todavía no hay telefónicos pasados a visita.'
      : `${num(n7 + nD)} a recuperar: ${num(n7)} del 700 y ${num(nD)} otros ($ ${num(f / 1000)} mil por mes de los otros).`
        + (vista === 'zona' ? ` En la zona ${zonaSel}: ${num(enZona)}.` : '');
    if (sinTablaRec) t += ' Falta crear la tabla en la base: por ahora no se puede guardar.';
    $('#rec-resumen').textContent = t;
  }
  const estado = t => { $('#estado').textContent = t; };

  function deshacer() {
    const h = historial.pop(); if (!h) return;
    const A = asig[h.esc];
    if (h.rec) { for (const [cod, antes] of h.rec) antes ? recup.add(cod) : recup.delete(cod); refrescar(); return; }
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
      const { altas, bajas } = pendRec();
      if (altas.length || bajas.length) {
        if (sinTablaRec) throw new Error('falta crear la tabla de recuperados en la base');
        const { error } = await sb.rpc('zonas_recuperar_guardar', { p_altas: altas, p_bajas: bajas });
        if (error) throw error;
        recGuardado = new Set(recup);
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
      b.textContent = `#${c.codigo} ${c.cliente} · ${nomZona(A.zona[c.manzana]).toLowerCase()} · ${DIAS[A.dia[c.manzana] - 1].toLowerCase()}`;
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
    if (vista === 'zona') DIAS.forEach((d, i) => grupos.push({ n: `${nomZona(zonaSel)} - ${d}`, f: id => A.zona[id] === zonaSel && A.dia[id] === i + 1, c: COL_DIA[i] }));
    else if (vista === 'zonasDia') for (let z = 1; z <= nZonas(); z++) grupos.push({ n: `${nomZona(z)} - ${DIAS[diaSel]}`, f: id => A.zona[id] === z && A.dia[id] === diaSel + 1, c: COL_ZONA[(z - 1) % COL_ZONA.length] });
    else for (let z = 1; z <= nZonas(); z++) for (let d = 1; d <= 5; d++) grupos.push({ n: `${nomZona(z)} - ${DIAS[d - 1]}`, f: id => A.zona[id] === z && A.dia[id] === d, c: COL_DIA[d - 1] });
    const kmlCol = h => 'aa' + h.slice(5, 7) + h.slice(3, 5) + h.slice(1, 3);
    let pm = '';
    for (const g of grupos) {
      const rings = contornos(g.f); if (!rings.length) continue;
      pm += `<Placemark><name>${g.n}</name><Style><LineStyle><color>ff${kmlCol(g.c).slice(2)}</color><width>2</width></LineStyle><PolyStyle><color>${kmlCol(g.c).replace(/^aa/, '55')}</color></PolyStyle></Style><MultiGeometry>`
        + rings.map(r => `<Polygon><outerBoundaryIs><LinearRing><coordinates>${r.map(p => p[0] + ',' + p[1]).join(' ')}</coordinates></LinearRing></outerBoundaryIs></Polygon>`).join('')
        + '</MultiGeometry></Placemark>\n';
    }
    descargar(`zonas_${RECUPERO ? 'recupero_' : ''}${quincenal() ? '4_vendedores_quincenal' : propuesta() ? 'propuesta_zz' : esc + '_vendedores'}.kml`, `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Zonas ${nomEsc(esc)}</name>\n${pm}</Document></kml>`, 'application/vnd.google-earth.kml+xml');
  }
  function exportarCSV() {
    const A = asig[esc];
    const esc_ = v => /[",;\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v;
    const filas = [['codigo', 'cliente', 'vendedor_actual', 'segmento', 'estado', 'a_recuperar', RECUPERO ? 'cuenta_en_recupero' : 'en_ruta', 'fact_mes', 'zona', 'zona_nombre', 'dia']];
    for (const c of clientes) filas.push([c.codigo, c.cliente, c.vendedor, c.segmento, c.estado, recup.has(c.codigo) ? 'si' : 'no', enRuta(c) ? 'si' : 'no', Math.round(c.fact_mes), A.zona[c.manzana], nomZona(A.zona[c.manzana]), DIAS[A.dia[c.manzana] - 1]]);
    descargar(`clientes_zonas_${RECUPERO ? 'recupero_' : ''}${quincenal() ? '4_vendedores_quincenal' : propuesta() ? 'propuesta_zz' : esc + '_vendedores'}.csv`, '﻿' + filas.map(f => f.map(esc_).join(';')).join('\n'), 'text/csv');
  }

  // ---------- Ruta de una zona en un día ----------
  // Orden de visita: arranca en el cliente más alejado del centro de la zona, va siempre al más cercano y
  // después destraba cruces (2-opt). Los km son en línea recta × 1,3 para aproximar el recorrido por calles.
  const km = (a, b) => Math.hypot((a.lat - b.lat) * 110.5, (a.lng - b.lng) * 95.0);
  function ordenar(pts) {
    if (pts.length < 3) return pts.slice();
    const centro = { lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length };
    let ini = 0, dmax = -1;
    pts.forEach((p, i) => { const d = km(p, centro); if (d > dmax) { dmax = d; ini = i; } });
    const libre = new Set(pts.keys()); libre.delete(ini); const o = [pts[ini]];
    while (libre.size) {
      const u = o[o.length - 1]; let mj = -1, dm = Infinity;
      for (const i of libre) { const d = km(u, pts[i]); if (d < dm) { dm = d; mj = i; } }
      o.push(pts[mj]); libre.delete(mj);
    }
    for (let mejora = true, vueltas = 0; mejora && vueltas < 50; vueltas++) {
      mejora = false;
      for (let i = 0; i < o.length - 2; i++) for (let j = i + 2; j < o.length; j++) {
        const a = o[i], b = o[i + 1], c = o[j], d = o[j + 1];
        const antes = km(a, b) + (d ? km(c, d) : 0), desp = km(a, c) + (d ? km(b, d) : 0);
        if (desp < antes - 1e-9) { o.splice(i + 1, j - i, ...o.slice(i + 1, j + 1).reverse()); mejora = true; }
      }
    }
    return o;
  }
  function armarRuta() {
    const A = asig[esc], z = Number($('#ruta-zona').value), d = Number($('#ruta-dia').value);
    const deProp = propuesta() && semanaSel, ordenProp = deProp && $('#ck-orden-prop').checked;
    const pts = deProp ? clientes.filter(c => enRuta(c) && visDe(c).zona === z && visDe(c).dia === d)
      : clientes.filter(c => enRuta(c) && A.zona[c.manzana] === z && A.dia[c.manzana] === d);
    quitarRuta();
    if (!pts.length) { $('#ruta-info').textContent = 'Esa zona no tiene clientes ese día.'; return; }
    const o = ordenProp ? pts.slice().sort((a, b) => (visDe(a).orden[semanaSel] ?? 1e9) - (visDe(b).orden[semanaSel] ?? 1e9)) : ordenar(pts);
    let tot = 0; for (let i = 1; i < o.length; i++) tot += km(o[i - 1], o[i]);
    rutaActual = { z, d, o };
    rutaCapa = L.layerGroup().addTo(map);
    L.polyline(o.map(c => [c.lat, c.lng]), { color: '#14213d', weight: 3, opacity: .8, interactive: false }).addTo(rutaCapa);
    o.forEach((c, i) => L.marker([c.lat, c.lng], {
      icon: L.divIcon({ className: 'nro' + (recup.has(c.codigo) || (deProp && c.estado === 'Telefónico') ? ' rec' : deProp && c.estado === 'Telefónico (camión 700)' ? ' t700' : ''), html: String(i + 1), iconSize: [20, 20] }),
      title: `${i + 1}. #${c.codigo} ${c.cliente}${recup.has(c.codigo) ? ' (a recuperar)' : ''}`,
    }).addTo(rutaCapa));
    map.fitBounds(L.latLngBounds(o.map(c => [c.lat, c.lng])), { padding: [40, 40] });
    const nr = o.filter(c => recup.has(c.codigo)).length;
    const n7 = deProp ? o.filter(c => c.estado === 'Telefónico (camión 700)').length : 0;
    $('#ruta-info').textContent = `${nomZona(z)} · ${DIAS[d - 1]}${deProp ? ` · semana ${semanaSel}, ${ordenProp ? 'orden de la propuesta' : 'orden optimizado'}` : ''}: ${o.length} clientes${nr ? ` (${nr} a recuperar)` : ''}${n7 ? ` (${n7} del 700)` : ''}, unos ${(tot * 1.3).toLocaleString('es-AR', { maximumFractionDigits: 1 })} km del primero al último.`;
    $('#btn-ruta-csv').disabled = $('#btn-ruta-quitar').disabled = false;
  }
  function quitarRuta() {
    if (rutaCapa) { rutaCapa.remove(); rutaCapa = null; }
    rutaActual = null; $('#ruta-info').textContent = '';
    $('#btn-ruta-csv').disabled = $('#btn-ruta-quitar').disabled = true;
  }
  function exportarRuta() {
    if (!rutaActual) return;
    const { z, d, o } = rutaActual;
    const esc_ = v => /[",;\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v;
    const filas = [['orden', 'codigo', 'cliente', 'vendedor_actual', 'estado', 'a_recuperar', 'lat', 'lng', 'mapa']];
    o.forEach((c, i) => filas.push([i + 1, c.codigo, c.cliente, c.vendedor, c.estado, recup.has(c.codigo) ? 'si' : 'no', c.lat, c.lng, `https://www.google.com/maps?q=${c.lat},${c.lng}`]));
    descargar(`ruta_${propuesta() ? cortoZona(z).toLowerCase() + (semanaSel ? '_semana' + semanaSel : '') : 'zona' + z}_${DIAS[d - 1].toLowerCase()}_${propuesta() ? 'propuesta_zz' : esc + '_vendedores'}.csv`, '\ufeff' + filas.map(f => f.map(esc_).join(';')).join('\n'), 'text/csv');
  }

  iniciar();
})();
