/* ==============================================================
   VORA OS - Situacion de mision
   Pasos 1-7: layout, canvas, dossier, reconciliacion, riel, motion,
   teclado y estados degradados.

   ---------------------------------------------------------------
   SOBRE LA DISPOSICION DEL CANVAS, que es una decision y no un
   detalle: las cuatro zonas del escenario queen ocupan el MISMO
   espacio local -- todas construyen su geometria en x=+-1.25,
   z=-5..-9. No estan georreferenciadas entre si: son escenas
   independientes, no regiones de un mapa comun. Proyectarlas en
   sus posiciones reales las superpondria exactamente.

   Por eso el canvas es un conjunto de "small multiples": cada zona
   ocupa una celda, y DENTRO de la celda la geometria es real --
   donde cae el retorno de radar respecto a la cavidad es una
   relacion medida. La posicion de las celdas entre si es layout,
   y la leyenda lo declara. Fingir un mapa georreferenciado seria
   inventar una relacion espacial que el sistema no tiene.
   ============================================================== */

/* == 1. CONFIG ============================================== */

const CFG = {
  pollMs: 500,
  staleAfterMs: 2000,     // sin respuesta -> enlace "stale"
  lostAfterMs: 6000,      // sin respuesta -> enlace "lost"
  frozenAfterMs: 4000,    // HTTP responde pero `ticks` no avanza -> "frozen"
  cell: { gap: 28, minSize: 180 },
  zoom: { min: 0.5, max: 4, step: 0.0016 },
  zone: {
    rMin: 16,             // radio del disco sin corroboracion
    rMax: 44,             // radio con corroboracion plena
    ringWidth: 5,
    haloScale: 2.6,
  },
  point: { lidar: 1.1, radar: 3.4 },
};

/* Modalidades, en el orden en que se dibujan sus arcos. */
const MODS = ["lidar", "thermal", "radar"];

/* Tokens leidos del CSS: el canvas y la hoja de estilos no pueden
   divergir si ambos leen la misma fuente. */
const T = {};
function loadTokens() {
  const cs = getComputedStyle(document.documentElement);
  const get = (n) => cs.getPropertyValue(n).trim();
  Object.assign(T, {
    void: get("--s-void"),
    line: get("--line"),
    lineStrong: get("--line-strong"),
    life0: get("--life-0"),
    life1: get("--life-1"),
    life2: get("--life-2"),
    lifeGlow: get("--life-glow"),
    riskUnknown: get("--risk-unknown"),
    riskStable: get("--risk-stable"),
    riskMod: get("--risk-mod"),
    riskHigh: get("--risk-high"),
    lidar: get("--mod-lidar"),
    thermal: get("--mod-thermal"),
    radar: get("--mod-radar"),
    tSecondary: get("--t-secondary"),
    tTertiary: get("--t-tertiary"),
  });
}

/* == 2. STATE =============================================== */

/* El snapshot del servidor y el estado de UI viven separados: un
   re-poll nunca debe poder mover la camara ni la seleccion. */
const snap = {
  zones: [], evidence: [], resources: [], ticks: 0,
  lidarScans: [], thermalScans: [], radarScans: [],
  spatialAssociations: [],
  mission: { id: "-", status: "-", uptime: 0 },
  receivedAt: 0,
  /* Ultimo valor de `ticks` visto y cuando cambio por ultima vez (reloj
     local). Un servidor que responde con el mismo estado para siempre
     no es un enlace vivo: la simulacion detras puede haber muerto. */
  ticksSeenAt: 0,
  runtimeError: null,
  moduleFailures: {},
  /* Identificador del proceso servidor que respondio por ultima vez con
     datos (cabecera X-Vora-Boot), y por que se perdio la sesion: ver
     poll(). */
  bootId: null,
  tokenRejected: false,
  authFailure: null,
};

const ui = {
  selectedZoneId: null,
  hoverZoneId: null,
  pressZoneId: null,
  camera: { yaw: -0.5, pitch: 0.34, zoom: 1, panX: 0, panY: 0 },
  drag: null,
  link: "booting",
  dirty: true,
};

/* Geometria calculada en el ultimo dibujo. El hit-testing lee de
   aqui, asi que nunca puede discrepar de lo que se ve. */
let hitZones = [];

/* Revision por region: una clave barata que cambia solo cuando lo
   pintado cambiaria. Con ella, la mayoria de los ticks de un
   escenario estable no tocan el DOM en absoluto. */
const rev = { dossier: "", rail: "" };

const els = {};
function cacheEls() {
  const id = (x) => document.getElementById(x);
  Object.assign(els, {
    canvas: id("situation-canvas"),
    overlay: id("canvas-overlay"),
    empty: id("canvas-empty"),
    rail: id("zone-rail"),
    dossier: id("dossier"),
    scale: id("legend-scale"),
    missionId: id("mission-id"),
    missionStatus: id("mission-status"),
    missionUptime: id("mission-uptime"),
    linkState: id("link-state"),
    linkText: id("link-text"),
    railRes: id("rail-resources"),
    railFeed: id("rail-feed"),
    railCov: id("rail-scans"),
    banner: id("link-banner"),
    bannerLabel: id("link-banner-label"),
    bannerAge: id("link-banner-age"),
  });
}

/* == 3. TRANSPORT =========================================== */

/* El servidor imprime la URL con el token en el fragmento
   (http://host:puerto/#token=...), que el navegador nunca envia. Aqui se
   cambia una sola vez por una cookie de sesion HttpOnly y se borra del
   campo de direcciones. Eso evita Referer, logs del servidor y
   location.search; no borra lo que el navegador ya guardo en su
   historial al abrir la URL, y el token sigue valido mientras viva el
   proceso. El script de la pagina no guarda ninguna credencial. Sin token ni
   cookie, /api/state responde 401 y la pagina marca "sesion no valida" --
   fail-closed, no un dashboard vacio que parece roto sin explicacion. */
async function startSession() {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
  if (!token) return;
  try {
    const res = await fetch("/api/session", {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
    });
    /* Con un token rechazado se conserva el fragmento: recargar la
       pagina permite reintentar en vez de dejar solo "sesion no valida". */
    if (!res.ok) {
      snap.tokenRejected = res.status === 401;
      return;
    }
  } catch {
    /* Sin sesion, poll() recibira 401 y mostrara "sesion no valida". */
    return;
  }
  history.replaceState(null, "", window.location.pathname + window.location.search);
}

async function poll() {
  try {
    const res = await fetch("/api/state", { cache: "no-store", credentials: "same-origin" });
    const boot = res.headers.get("X-Vora-Boot");
    if (res.status === 401) {
      /* El servidor responde pero no reconoce la sesion: distinto de no
         llegar a el. Si ya habia recibido datos de otro proceso, el
         servidor se reinicio y olvido todas las sesiones; si es el
         mismo, la sesion se reemplazo (admite 16) o el token es otro. */
      snap.authFailure = !snap.bootId
        ? (snap.tokenRejected ? "rejected" : "missing")
        : boot !== snap.bootId ? "restart" : "invalid";
      setLink("unauth");
      return;
    }
    if (!res.ok) throw new Error(res.status);
    if (boot) snap.bootId = boot;
    snap.authFailure = null;
    const prevTicks = snap.ticks;
    ingest(await res.json());
    snap.receivedAt = performance.now();
    if (!snap.ticksSeenAt || snap.ticks !== prevTicks) snap.ticksSeenAt = snap.receivedAt;
    const completed = snap.mission.status === "completed";
    const stuck = !completed && snap.receivedAt - snap.ticksSeenAt > CFG.frozenAfterMs;
    const faulted = Object.keys(snap.moduleFailures).length > 0;
    setLink(snap.runtimeError || stuck ? "frozen" : faulted ? "faulted" : "live");
  } catch {
    const age = performance.now() - snap.receivedAt;
    if (!snap.receivedAt || age > CFG.lostAfterMs) setLink("lost");
    else if (age > CFG.staleAfterMs) setLink("stale");
  }
}

/* Los estados del enlace, en un solo sitio. Cada fila dice todo lo que
   la pagina muestra de ese estado; `poll()` solo elige cual es, y los
   renders leen de aqui. Anadir un estado es anadir una fila (y, si hace
   falta, la funcion de su detalle).

     text        etiqueta junto al punto de la barra de mando
     severity    "idle" | "ok" | "warn" | "bad": el CSS colorea y desatura
                 por este valor (body[data-severity]), no por el nombre
     banner      rotulo de la banda de aviso; null = sin banda
     detail      texto de la banda, junto al rotulo
     status      lo que ESTADO muestra en lugar del estado de la mision;
                 null = ESTADO sigue diciendo el de la mision. Su color
                 sale de `clockStops`: rojo si el reloj se detiene, ambar
                 si sigue contando
     clockStops  TIEMPO se atenua en su ultimo valor. `faulted` es la
                 excepcion: un modulo cayo pero la simulacion continua,
                 asi que el reloj sigue contando */
const LINK_STATES = {
  booting: { text: "Conectando", severity: "idle", banner: null, status: null, clockStops: false },
  live: { text: "Enlace activo", severity: "ok", banner: null, status: null, clockStops: false },
  stale: {
    text: "Enlace inestable", severity: "warn", banner: "ENLACE INESTABLE",
    detail: ageDetail, status: "sin datos", clockStops: true,
  },
  lost: {
    text: "Sin enlace", severity: "bad", banner: "SIN ENLACE",
    detail: ageDetail, status: "sin enlace", clockStops: true,
  },
  frozen: {
    text: "Simulación detenida", severity: "bad", banner: "SIMULACIÓN DETENIDA",
    detail: frozenDetail, status: "detenido", clockStops: true,
  },
  faulted: {
    text: "Módulo con fallo", severity: "warn", banner: "MÓDULO CON FALLO",
    detail: faultedDetail, status: "con fallo", clockStops: false,
  },
  unauth: {
    text: "Sesión no válida", severity: "bad", banner: "SESIÓN NO VÁLIDA",
    detail: unauthDetail, status: "sin sesión", clockStops: true,
  },
};

/* La edad se calcula con el reloj local, no con el snapshot: el snapshot
   es precisamente lo que dejo de llegar. */
function ageDetail() {
  return snap.receivedAt
    ? "último dato hace " +
      Math.round((performance.now() - snap.receivedAt) / 1000) +
      " s · datos congelados en pantalla"
    : "sin ningún dato desde el arranque";
}

/* El servidor responde, pero lo que muestra ya no se actualiza: distinto
   de perder la red, y el operador debe saberlo. */
function frozenDetail() {
  return (snap.runtimeError
    ? "fallo del hilo de simulación: " + snap.runtimeError
    : "el servidor responde pero la simulación no avanza") +
    " · datos congelados en pantalla";
}

/* El enlace y la simulacion siguen vivos: lo que cambia es que una fuente
   cayo y ya no aporta datos. Sin este aviso una zona sin evidencia nueva
   se lee como una escena tranquila. */
function faultedDetail() {
  return "sin datos de: " + Object.keys(snap.moduleFailures).join(", ") +
    " · el resto de la simulación continúa";
}

/* El servidor esta ahi y responde; lo que falta es una sesion. Cada texto
   dice que paso y la unica salida: el enlace que imprime la consola del
   servidor lleva el token. */
function unauthDetail() {
  return ({
    missing: "no hay sesión abierta: abre el enlace completo que imprime la consola del servidor",
    rejected: "el servidor no reconoce el token de este enlace (¿es de una ejecución anterior?): abre el enlace que imprime ahora la consola",
    restart: "el servidor se reinició y olvidó la sesión: abre de nuevo el enlace que imprime la consola",
    invalid: "la sesión ya no es válida (otra la reemplazó o el token cambió): abre de nuevo el enlace que imprime la consola",
  })[snap.authFailure] + (snap.receivedAt ? " · datos congelados en pantalla" : "");
}

function setLink(state) {
  if (ui.link === state) return;
  ui.link = state;
  els.linkState.dataset.state = state;
  els.linkState.dataset.severity = LINK_STATES[state].severity;
  els.linkText.textContent = LINK_STATES[state].text;
  ui.dirty = true;
}

function ingest(d) {
  snap.zones = d.zones || [];
  snap.evidence = d.evidence || [];
  snap.resources = d.resources || [];
  snap.lidarScans = d.lidar_scans || [];
  snap.thermalScans = d.thermal_scans || [];
  snap.radarScans = d.radar_scans || [];
  snap.spatialAssociations = d.spatial_associations || [];
  /* `mission_status` es una cadena, no un objeto: leerle `.state`
     devolvia siempre indefinido y la barra de mando mostraba un
     guion permanente. El snapshot no lleva id de mision, asi que ese
     campo se retira en vez de rellenarse con un valor inventado. */
  snap.mission = {
    status: d.mission_status ?? "-",
    /* `sim_uptime_s` se detiene cuando se detienen los ticks; `uptime_s`
       es el reloj del servidor al responder y sigue avanzando. */
    uptime: d.sim_uptime_s ?? d.uptime_s ?? 0,
  };
  snap.ticks = d.ticks ?? 0;
  snap.runtimeError = d.runtime_alive === false ? (d.runtime_error || "hilo de simulación detenido") : null;
  snap.moduleFailures = d.module_failures || {};
  trackCorroboration();
  ui.dirty = true;
  // Sesion de cliente (mission.js) -- ver ese archivo para que se
  // persiste y por que: nada de esto es el ciclo de vida real de
  // Mission Manager, que el snapshot ni siquiera expone un id de.
  heartbeatMission(d.zone_summary, snap.ticks);
}

/* == 4. SELECTORS =========================================== */
/* Derivaciones puras del snapshot. Sin DOM, sin canvas: es la
   frontera que hace testeable el resto. */

/* El universo de zonas es la union de las que tienen creencia y
   las que solo fueron barridas. Una zona observada y vacia no
   puede desaparecer de la pantalla. */
function zoneIds() {
  const s = new Set();
  snap.zones.forEach((z) => s.add(z.zone_id));
  [snap.lidarScans, snap.thermalScans, snap.radarScans]
    .forEach((arr) => arr.forEach((x) => s.add(x.zone_id)));
  return [...s].sort();
}

function zoneModel(zoneId) {
  const z = snap.zones.find((x) => x.zone_id === zoneId) || null;
  const facts = z?.classification_facts || [];
  const lidar = snap.lidarScans.find((x) => x.zone_id === zoneId) || null;
  const thermal = snap.thermalScans.find((x) => x.zone_id === zoneId) || null;
  const radar = snap.radarScans.find((x) => x.zone_id === zoneId) || null;

  const mods = {
    lidar: facts.includes("CAVITY_PRESENT"),
    thermal: facts.includes("THERMAL_PRESENT"),
    radar: facts.includes("RESPIRATION_PRESENT"),
  };
  const modCount = MODS.filter((m) => mods[m]).length;

  const corroborated =
    facts.includes("SPATIALLY_CORROBORATED") ||
    facts.includes("RESPIRATION_CORROBORATED");

  /* Radio por corroboracion; opacidad por p_life. Dos canales,
     porque p_life satura (R-19) y la corroboracion no: la magnitud
     no se pierde, deja de ser el unico portador de la senal. */
  const corrLevel = corroborated ? 1 : modCount >= 2 ? 0.6 : modCount === 1 ? 0.3 : 0;

  return {
    zoneId, zone: z, facts, mods, modCount, corroborated, corrLevel,
    pLife: z?.p_life ?? 0,
    stability: z?.stability || "UNKNOWN",
    observed: Boolean(lidar || thermal || radar),
    observedBy: { lidar: Boolean(lidar), thermal: Boolean(thermal), radar: Boolean(radar) },
    points: lidar?.points || [],
    radarReturns: radar?.returns || [],
    /* Las asociaciones vienen anidadas: el evento por zona trae un
       array `associations`. Leerlas del nivel superior devolvia
       siempre indefinido y ninguna linea se dibujaba nunca. */
    associations: (snap.spatialAssociations
      .find((a) => a.zone_id === zoneId)?.associations || [])
      .filter((a) => a.cavity_centroid && a.thermal_centroid),
    /* Termica<->Radar. Vacio hoy en todas las zonas, y no por un fallo:
       ninguna zona del escenario queen tiene candidato termico y
       candidato de radar a la vez, asi que no hay nada que emparejar.
       Un vacio aqui no significa "nada cerca" -- el evento tampoco lo
       distingue de "sin barrido de radar". */
    respirationAssociations: (snap.spatialAssociations
      .find((a) => a.zone_id === zoneId)?.respiration_associations || [])
      .filter((a) => a.thermal_centroid && a.respiration_centroid),
    interpretation: z?.interpretation || null,
    /* Fase 4 -- distinto de `interpretation`: ese viene de
       explain_zone() (veredicto de Classification), este de
       brief_zone_from_reader() (prosa para el rescatista, y el unico
       lugar que trae la nota de Fase 3 sobre RESPIRATION). `null`
       cuando ningun StateReaderModule esta compuesto en el runtime --
       ausencia normal, no un fallo. */
    briefing: z?.briefing || null,
  };
}

function allZoneModels() { return zoneIds().map(zoneModel); }

/* La evidencia de una zona se deriva del array global filtrando por
   zona: `ZoneState.evidence_ids` llega vacio en el snapshot, asi que
   leerlo daria una trazabilidad siempre vacia justo en el panel que
   existe para mostrarla. Mas reciente primero. */
function zoneEvidence(zoneId, limit = 14) {
  return snap.evidence
    .filter((e) => e.zone_id === zoneId)
    .slice()
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .slice(0, limit);
}

function missionSummary() {
  const models = allZoneModels();
  return {
    observed: models.filter((m) => m.observed).length,
    withEvidence: models.filter((m) => m.modCount > 0).length,
    corroborated: models.filter((m) => m.corroborated).length,
    total: models.length,
  };
}

const MOD_LABEL = {
  lidar: "Geometría (LiDAR)",
  thermal: "Térmica",
  radar: "Respiración (Radar)",
};
const MOD_PRESENT = {
  lidar: "Cavidad detectada",
  thermal: "Anomalía detectada",
  radar: "Firma respiratoria",
};
const MOD_EMPTY = {
  lidar: "Sin cavidad compatible",
  thermal: "Sin anomalía observable",
  radar: "Sin evidencia respiratoria",
};
/* Rotulo corto de modalidad para las etiquetas del canvas: la clave
   interna ("lidar", "thermal") no es texto de pantalla. */
const MOD_SHORT = { lidar: "LiDAR", thermal: "Térmica", radar: "Radar" };

const RISK_LABEL = {
  STABLE: "Estable",
  MODERATE: "Riesgo moderado",
  HIGH_RISK: "Riesgo alto",
  UNKNOWN: "No evaluado",
};

/* Estado de una modalidad en una zona, con la distincion que el
   sistema entero defiende: observada-y-nada no es lo mismo que no
   observada. */
function modalityState(m, key) {
  if (m.mods[key]) {
    /* La amplitud acompana al rotulo del radar porque es una medida
       real y continua -- varia con cuanta materia cruzo el retorno --
       y no una confianza derivada del umbral que ya admitio al
       candidato. Distingue un retorno debil de uno rotundo, que es
       exactamente lo que decide si alguien entra. */
    let text = MOD_PRESENT[key];
    if (key === "radar" && m.radarReturns.length) {
      text += m.radarReturns.length === 1
        ? " · amplitud " + fmtAmp(m.radarReturns[0].amplitude)
        : " · " + m.radarReturns.length + " retornos";
    }
    return { state: "present", text };
  }
  if (m.observedBy[key]) return { state: "empty", text: MOD_EMPTY[key] };
  return { state: "unobserved", text: "No observada" };
}

function fmtAmp(v) {
  return typeof v === "number" ? v.toFixed(2) : "—";
}

function fmtPos(p) {
  return p
    ? ["x", "y", "z"].map((k) => (p[k] >= 0 ? " " : "") + p[k].toFixed(2)).join("  ")
    : null;
}

/* Un retorno por detras de la superficie reconstruida no es un error:
   es lo que significa ver a traves de la pared. Se comprueba contra
   la envolvente de la nube para poder decirlo en el dossier en vez de
   dejar al operador dudando de la pantalla. */
function radarBeyondSurface(m) {
  if (!m.points.length || !m.radarReturns.length) return false;
  const lim = (k) => {
    const v = m.points.map((p) => p[k]);
    return [Math.min(...v), Math.max(...v)];
  };
  const [x0, x1] = lim("x"), [y0, y1] = lim("y"), [z0, z1] = lim("z");
  return m.radarReturns.some((r) => {
    const p = r.position;
    return !!p && (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1 || p.z < z0 || p.z > z1);
  });
}

/* == 5. CANVAS ============================================== */

const ctx = () => els.canvas.getContext("2d");

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const r = els.canvas.getBoundingClientRect();
  els.canvas.width = Math.round(r.width * dpr);
  els.canvas.height = Math.round(r.height * dpr);
  const c = ctx();
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  ui.dirty = true;
  return r;
}

/* Rejilla de celdas: una por zona, lo mas cuadrada posible. */
function layoutCells(count, w, h) {
  if (!count) return [];
  const cols = Math.min(count, Math.ceil(Math.sqrt(count)));
  const rows = Math.ceil(count / cols);
  const g = CFG.cell.gap;
  const cw = (w - g * (cols + 1)) / cols;
  const ch = (h - g * (rows + 1)) / rows;
  return Array.from({ length: count }, (_, i) => {
    const cx = i % cols, cy = Math.floor(i / cols);
    return {
      x: g + cx * (cw + g), y: g + cy * (ch + g),
      w: cw, h: ch,
      centerX: g + cx * (cw + g) + cw / 2,
      centerY: g + cy * (ch + g) + ch / 2,
    };
  });
}

/* Proyeccion ortografica con yaw/pitch. Devuelve coordenadas
   relativas al centro de la celda; el llamador las traslada. */
function project(p, origin, scale, cam) {
  let x = (p.x - origin.x) * scale;
  let y = (p.y - origin.y) * scale;
  let z = (p.z - origin.z) * scale;

  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  [x, z] = [x * cy - z * sy, x * sy + z * cy];

  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  [y, z] = [y * cp - z * sp, y * sp + z * cp];

  return { x, y: -y, depth: z };
}

/* Encuadre UNICO para todas las celdas, medido sobre la extension ya
   proyectada y no sobre la dispersion en 3D.

   Las dos cosas son decisiones, no detalles.

   Una escala por celda dejaba cada zona a un zoom distinto -- medido:
   la nube de Z-A ocupaba el 35% del alto de su celda y la de Z-B el
   53% -- y en un conjunto de small multiples eso destruye lo unico
   que el formato sirve para hacer, que es comparar celdas entre si.
   Con una cavidad grande y una pequena dibujadas al mismo tamano, la
   pantalla afirma algo falso.

   Y medir en proyeccion, no en dispersion 3D, es lo que hace que el
   encuadre siga siendo correcto cuando el operador gira la camara:
   la misma nube ocupa distinto sitio segun el angulo. Medirla antes
   de proyectar dejaba dos tercios del canvas vacios. */
function fitScene(models, cell) {
  const origins = new Map();
  let maxX = 0, maxY = 0;

  for (const m of models) {
    /* Los retornos de radar cuentan SIEMPRE, no solo cuando no hay
       LiDAR. El radar ve a traves de la pared, asi que un retorno cae
       legitimamente por detras de la superficie reconstruida -- en
       Z-B, 0.9 m mas alla del borde lejano de su nube. Midiendo solo
       el LiDAR, el encuadre no le reservaba sitio y el recorte por
       celda lo borraba: medido, 3 de 189 orientaciones de camara lo
       expulsaban de su celda. El unico dato que prueba que alguien
       respira desaparecia al girar la vista. */
    /* Se filtra por presencia igual que `drawRadarReturns`: el dossier
       sabe decir "sin posicion espacial", asi que el canvas tiene que
       saber ignorarlo. Sin el filtro un solo retorno sin centroide
       lanzaba dentro de `project()` y se llevaba por delante el dibujo
       entero -- un campo ausente apagaba la pantalla. */
    const pts = m.points.concat(
      m.radarReturns.map((r) => r.position).filter(Boolean));
    if (!pts.length) { origins.set(m.zoneId, { x: 0, y: 0, z: -6 }); continue; }

    let sx = 0, sy = 0, sz = 0;
    for (const p of pts) { sx += p.x; sy += p.y; sz += p.z; }
    const origin = { x: sx / pts.length, y: sy / pts.length, z: sz / pts.length };
    origins.set(m.zoneId, origin);

    /* La proyeccion es lineal en la escala, asi que medir a escala 1
       y multiplicar despues es exacto, no una aproximacion. */
    for (const p of pts) {
      const q = project(p, origin, 1, ui.camera);
      maxX = Math.max(maxX, Math.abs(q.x));
      maxY = Math.max(maxY, Math.abs(q.y));
    }
  }

  /* 0.86 y no mas: el origen se ancla al centro de la celda, asi que
     una nube descentrada respecto a su centroide gasta margen por un
     lado. Con recorte por celda el riesgo de invasion ya no existe. */
  const pad = 0.86;
  const scale = (maxX > 0 || maxY > 0)
    ? Math.min(cell.w * pad / (2 * Math.max(maxX, 1e-6)),
               cell.h * pad / (2 * Math.max(maxY, 1e-6)))
    : 40;
  return { origins, scale };
}

function draw() {
  const rect = els.canvas.getBoundingClientRect();
  const c = ctx();
  const models = allZoneModels();

  c.clearRect(0, 0, rect.width, rect.height);
  c.fillStyle = T.void;
  c.fillRect(0, 0, rect.width, rect.height);

  els.empty.hidden = models.length > 0;
  if (!models.length) {
    drawReticle(c, rect.width, rect.height);
    hitZones = [];
    renderLabels([], []);
    return;
  }

  const cells = layoutCells(models.length, rect.width, rect.height);
  const cam = ui.camera;
  const fit = fitScene(models, cells[0]);   // las celdas son iguales
  const s = fit.scale * cam.zoom;
  const next = [];

  models.forEach((m, i) => {
    const cell = cells[i];
    const origin = fit.origins.get(m.zoneId);
    const ox = cell.centerX + cam.panX;
    const oy = cell.centerY + cam.panY;
    const selected = ui.selectedZoneId === m.zoneId;
    const dim = ui.selectedZoneId && !selected ? 0.55 : 1;

    drawCellFrame(c, cell, selected, dim);

    /* Recorte a la celda: al acercar la camara, la geometria de una
       zona invadia la celda vecina y se leia como si perteneciera a
       ella. El marco se dibuja fuera del recorte para que su trazo no
       quede cortado por la mitad. */
    c.save();
    roundRect(c, cell.x, cell.y, cell.w, cell.h, 14);
    c.clip();

    drawLidar(c, m, origin, s, ox, oy, dim);
    drawRadarReturns(c, m, origin, s, ox, oy, dim);
    drawAssociations(c, m, origin, s, ox, oy, dim);

    const body = drawZoneBody(c, m, ox, oy, selected, dim);
    c.restore();

    next.push({ zoneId: m.zoneId, x: ox, y: oy,
                r: body.hitRadius, labelR: body.labelRadius, cell });
  });

  hitZones = next;
  renderLabels(models, hitZones);
  setText(els.scale,
    `Escala común a todas las celdas · su posición no es georreferencia · zoom ${cam.zoom.toFixed(2)}×`);
}

function drawCellFrame(c, cell, selected, dim) {
  c.save();
  c.globalAlpha = dim;
  c.strokeStyle = selected ? T.lineStrong : T.line;
  c.lineWidth = 1;
  roundRect(c, cell.x + 0.5, cell.y + 0.5, cell.w - 1, cell.h - 1, 14);
  c.stroke();
  c.restore();
}

/* Nube LiDAR: textura de contexto, nunca la figura. */
function drawLidar(c, m, origin, s, ox, oy, dim) {
  if (!m.points.length) return;
  c.save();
  c.globalAlpha = 0.3 * dim;
  c.fillStyle = T.lidar;
  for (const p of m.points) {
    const q = project(p, origin, s, ui.camera);
    c.fillRect(ox + q.x, oy + q.y, CFG.point.lidar, CFG.point.lidar);
  }
  c.restore();
}

/* Retornos de radar en su posicion real. Es la unica modalidad que
   prueba que algo esta vivo ahora mismo, y hasta el canvas v2 era la
   unica sin sitio en el espacio.

   Marcador con forma propia -- nucleo, anillo y retícula -- y no un
   punto mas grande: un punto solo se distingue de la nube LiDAR por
   el tamano, y a la escala compartida de las celdas el tamano ya
   significa otra cosa. El halo varia con la amplitud, que es una
   medida real; el anillo no, porque el anillo dice "hay un retorno
   aqui" y eso no admite grados. */
function drawRadarReturns(c, m, origin, s, ox, oy, dim) {
  if (!m.radarReturns.length) return;
  const R = CFG.point.radar;
  c.save();
  for (const r of m.radarReturns) {
    if (!r.position) continue;
    const q = project(r.position, origin, s, ui.camera);
    const x = ox + q.x, y = oy + q.y;
    const amp = Math.max(0.15, Math.min(1, r.amplitude ?? 0.5));

    c.globalAlpha = 0.16 * dim * amp;
    c.fillStyle = T.radar;
    c.beginPath();
    c.arc(x, y, R * 3.2, 0, Math.PI * 2);
    c.fill();

    c.globalAlpha = dim;
    c.strokeStyle = T.radar;
    c.lineWidth = 1;
    c.beginPath();
    c.arc(x, y, R * 2.2, 0, Math.PI * 2);
    c.stroke();

    /* Retícula corta: cuatro trazos que apuntan al retorno sin
       taparlo. Es lo que lo hace legible cuando cae sobre la nube. */
    c.globalAlpha = 0.7 * dim;
    c.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      c.moveTo(x + dx * R * 3.0, y + dy * R * 3.0);
      c.lineTo(x + dx * R * 4.2, y + dy * R * 4.2);
    }
    c.stroke();

    c.globalAlpha = dim;
    c.fillStyle = T.radar;
    c.beginPath();
    c.arc(x, y, R * 0.9, 0, Math.PI * 2);
    c.fill();
  }
  c.restore();
}

/* Vinculo de corroboracion: solo si existe la asociacion. Una
   linea decorativa en una herramienta de rescate es una mentira
   visual, no un adorno. */
function drawAssociations(c, m, origin, s, ox, oy, dim) {
  if (!m.associations.length) return;
  /* Mientras dura el destello el guion recorre la linea y esta se
     engrosa: el vinculo se lee como "esto se acaba de conectar". En
     reposo vuelve a ser exactamente lo que era. */
  const t0 = anim.pulse.get(m.zoneId);
  const fresh = t0 !== undefined;
  const e = fresh ? easeOut(Math.min(1, (performance.now() - t0) / PULSE_MS)) : 1;
  c.save();
  c.globalAlpha = (fresh ? 1 - 0.2 * e : 0.8) * dim;
  c.strokeStyle = T.life2;
  c.lineWidth = fresh ? 1 + 1.4 * (1 - e) : 1;
  c.setLineDash([3, 3]);
  c.lineDashOffset = fresh ? -14 * e : 0;
  for (const a of m.associations) {
    const p = project(a.cavity_centroid, origin, s, ui.camera);
    const q = project(a.thermal_centroid, origin, s, ui.camera);
    c.beginPath();
    c.moveTo(ox + p.x, oy + p.y);
    c.lineTo(ox + q.x, oy + q.y);
    c.stroke();
  }
  c.restore();
}

/* Cuerpo de zona.
   radio    <- corroboracion   (no satura)
   opacidad <- p_life          (conserva la magnitud)
   arcos    <- modalidades presentes
   barra    <- riesgo estructural, visible siempre incluso UNKNOWN */
function drawZoneBody(c, m, x, y, selected, dim) {
  /* Hover y press escalan el cuerpo entero: radio, arcos, marca de
     riesgo y radio de impacto con el. Lo que crece es exactamente lo
     que se puede pulsar, no una decoracion superpuesta. */
  const grow = 1
    + 0.05 * (anim.hover.get(m.zoneId) || 0)
    - (ui.pressZoneId === m.zoneId ? 0.02 : 0);
  const r = (CFG.zone.rMin + (CFG.zone.rMax - CFG.zone.rMin) * m.corrLevel) * grow;
  const fillAlpha = m.observed ? 0.10 + 0.5 * m.pLife : 0.06;

  c.save();
  c.globalAlpha = dim;

  if (m.modCount > 0) {
    const g = c.createRadialGradient(x, y, r * 0.2, x, y, r * CFG.zone.haloScale);
    g.addColorStop(0, T.lifeGlow);
    g.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = g;
    c.beginPath();
    c.arc(x, y, r * CFG.zone.haloScale, 0, Math.PI * 2);
    c.fill();
  }

  c.globalAlpha = fillAlpha * dim;
  c.fillStyle = m.corroborated ? T.life2 : m.modCount ? T.life1 : T.life0;
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fill();

  c.globalAlpha = dim;
  c.lineWidth = selected ? 2 : 1;
  c.strokeStyle = selected ? T.life2 : m.observed ? T.lineStrong : T.line;
  if (!m.observed) c.setLineDash([4, 4]);
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.stroke();
  c.setLineDash([]);

  drawModalityArcs(c, m, x, y, r, dim);
  drawRiskTick(c, m, x, y, r, dim);
  drawCorrPulse(c, m, x, y, r, dim);

  c.restore();
  /* El radio de la etiqueta ignora `grow`: el texto no debe bajar tres
     pixeles cada vez que el cursor pasa por encima del disco. */
  return { hitRadius: r * 1.25, labelRadius: (r / grow) * 1.25 };
}

/* Un arco por modalidad presente: la firma de evidencia se lee a
   distancia sin necesidad del numero. */
function drawModalityArcs(c, m, x, y, r, dim) {
  const active = MODS.filter((k) => m.mods[k]);
  if (!active.length) return;
  const gap = 0.16;
  const span = (Math.PI * 2) / active.length - gap;
  const rr = r + CFG.zone.ringWidth + 2;

  c.save();
  c.globalAlpha = dim;
  c.lineWidth = CFG.zone.ringWidth;
  c.lineCap = "butt";
  active.forEach((k, i) => {
    const start = -Math.PI / 2 + i * ((Math.PI * 2) / active.length) + gap / 2;
    c.strokeStyle = T[k];
    c.beginPath();
    c.arc(x, y, rr, start, start + span);
    c.stroke();
  });
  c.restore();
}

function drawRiskTick(c, m, x, y, r, dim) {
  const color = {
    STABLE: T.riskStable, MODERATE: T.riskMod,
    HIGH_RISK: T.riskHigh, UNKNOWN: T.riskUnknown,
  }[m.stability] || T.riskUnknown;

  c.save();
  c.globalAlpha = dim;
  c.strokeStyle = color;
  c.lineWidth = 3;
  c.lineCap = "round";
  const top = y - r - CFG.zone.ringWidth - 10;
  c.beginPath();
  c.moveTo(x - 7, top);
  c.lineTo(x + 7, top);
  c.stroke();
  c.restore();
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/* == 6. RENDER ============================================== */

/* Etiquetas en HTML superpuesto, no pintadas en el canvas: texto
   real, seleccionable, con el antialiasing del sistema, y sin
   volver a dibujarse en cada frame. */
/* Se reconstruian en cada frame -- y con los tweens del paso 6 eso
   son diez reconstrucciones por hover, no dos por segundo. Aqui solo
   se mueven: se escribe la posicion, no el nodo. */
function renderLabels(models, hits) {
  reconcile(
    els.overlay, hits, (h) => h.zoneId,
    () => {
      const d = document.createElement("div");
      d.className = "zone-label";
      const id = document.createElement("span");
      id.className = "zone-label-id";
      const note = document.createElement("span");
      note.className = "zone-label-note";
      d.append(id, note);
      return d;
    },
    (el, h) => {
      const m = models.find((x) => x.zoneId === h.zoneId);
      /* La distincion se conserva intacta: no observada, observada y
         vacia, y observada con evidencia son tres rotulos distintos. */
      const note = !m.observed ? "NO OBSERVADA"
        : m.modCount === 0 ? "sin evidencia"
        : MODS.filter((k) => m.mods[k]).map((k) => MOD_SHORT[k]).join(" + ");
      setText(el.querySelector(".zone-label-id"), h.zoneId);
      setText(el.querySelector(".zone-label-note"), note);
      setAttr(el, "data-selected", ui.selectedZoneId === h.zoneId);
      const left = h.x + "px";
      const top = (h.y + h.labelR + 14) + "px";
      if (el.style.left !== left) el.style.left = left;
      if (el.style.top !== top) el.style.top = top;
    },
  );
}

/* El riel de zonas tambien se reconcilia: se reconstruia con
   innerHTML en cada seleccion, y eso borra el foco del teclado justo
   en el momento de navegar con el teclado. El numero de la pastilla
   es ademas lo que hace descubrible el atajo 1-9. */
function renderZoneRail(models) {
  reconcile(
    els.rail,
    models.map((m, i) => ({ m, i })),
    (x) => x.m.zoneId,
    () => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "zone-pill";
      b.setAttribute("role", "tab");
      const idx = document.createElement("span");
      idx.className = "pill-idx";
      const name = document.createElement("span");
      name.className = "pill-id";
      const mods = document.createElement("span");
      mods.className = "pill-mods";
      for (const k of MODS) {
        const dot = document.createElement("i");
        dot.className = "pill-mod";
        dot.dataset.mod = k;
        mods.append(dot);
      }
      const risk = document.createElement("i");
      risk.className = "pill-risk";
      b.append(idx, name, mods, risk);
      return b;
    },
    (el, x) => {
      setText(el.querySelector(".pill-idx"), x.i < 9 ? String(x.i + 1) : "");
      setText(el.querySelector(".pill-id"), x.m.zoneId);
      setAttr(el, "data-zone", x.m.zoneId);
      setAttr(el, "aria-selected", ui.selectedZoneId === x.m.zoneId);
      const dots = el.querySelectorAll(".pill-mod");
      MODS.forEach((k, j) => setAttr(dots[j], "data-on", x.m.mods[k]));
      setAttr(el.querySelector(".pill-risk"), "data-risk", x.m.stability);
    },
  );
}

/* ESTADO y TIEMPO describen la mision, y solo valen mientras los datos
   llegan y la simulacion avanza. En cualquier otro estado del enlace la
   barra no puede seguir diciendo "running": dice por que ya no lo sabe
   (`status` de LINK_STATES) y el reloj queda atenuado en el ultimo valor
   recibido (`clockStops`). */
function renderCommandBar() {
  const state = LINK_STATES[ui.link];
  setText(els.missionStatus, state.status ?? snap.mission.status);
  setAttr(els.missionStatus, "data-stale",
    state.status === null ? false : state.clockStops ? true : "warn");
  setAttr(els.missionUptime, "data-stale", state.clockStops);
  const s = Math.floor(snap.mission.uptime);
  setText(els.missionUptime,
    `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`);
}

/* -- Riel de telemetria (paso 5) ----------------------------------
   Subordinado por contrato: 96 px que no crecen, tipografia pequena,
   y ningun color que no signifique ya algo en el resto de la
   pantalla. El riel dice como esta el robot y prueba que el sistema
   sigue vivo; no compite con el canvas ni con el dossier.

   Tres decisiones que no son de estilo:

   1. `utilization` significa DOS cosas distintas en el mismo campo.
      Para CPU y GPU es carga de trabajo. Para la bateria es CARGA
      RESTANTE -- resource_demo.py la llama `charge` y le aplica
      histeresis de recarga. Rotular ambas igual pondria "74% de
      uso" donde hay "74% de bateria restante": exactamente lo
      contrario, en el unico dato que decide si el robot vuelve.

   2. El riel es acromatico. No hay umbral de "bateria baja" porque
      no hay dato con el que calibrarlo, y fijarlo aqui seria elegir
      un numero por estetica. El unico color procede de `state`, que
      lo declara el sistema, no esta pantalla.

   3. El bridge guarda el ULTIMO barrido de cada zona, no un
      historial: contar `lidar_scans` da zonas cubiertas, no barridos
      ejecutados. Por eso el rotulo dice zonas y la seccion se llama
      Cobertura. */

const RES_SENSE = { battery: "carga", cpu: "uso", gpu: "uso" };

function resourceRows() {
  return snap.resources.map((r) => {
    const meta = r.metadata || {};
    const rt = r.runtime || {};
    const type = String(meta.resource_type || "").toLowerCase();

    let value = "—";
    let frac = null;

    if (rt.utilization !== null && rt.utilization !== undefined) {
      frac = rt.utilization;
      value = Math.round(frac * 100) + "% " + (RES_SENSE[type] || "uso");
    } else if (rt.allocated && r.capabilities && r.capabilities.capacity) {
      const used = rt.allocated.value;
      const cap = r.capabilities.capacity.value;
      frac = cap ? used / cap : null;
      value = used + "/" + cap + " " + rt.allocated.unit;
    }

    const extra = rt.temperature
      ? rt.temperature.value + "°" + rt.temperature.unit
      : rt.voltage ? rt.voltage.value + " " + rt.voltage.unit : "";

    return {
      key: meta.identifier || meta.name || type,
      name: meta.name || type || "?",
      value, frac, extra,
      state: String(r.state || "").toUpperCase(),
    };
  });
}

/* El feed es un indicador de vida, no una superficie de lectura: a
   2 Hz nadie lee cuatro lineas. Por eso son tres, no se destacan y
   no se animan al entrar -- la animacion prometeria que hay algo
   que leer ahi. */
function feedRows(limit = 3) {
  return snap.evidence
    .slice()
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .slice(0, limit);
}

const COV = [
  { key: "lidar", label: "LiDAR", get: () => snap.lidarScans, n: (s) => (s.points || []).length, unit: "pts" },
  { key: "thermal", label: "Térmica", get: () => snap.thermalScans, n: (s) => (s.readings || []).length, unit: "rayos" },
  { key: "radar", label: "Radar", get: () => snap.radarScans, n: (s) => (s.returns || []).length, unit: "ret" },
];

function coverageRows() {
  const rows = COV.map((m) => {
    const arr = m.get();
    const total = arr.reduce((t, s) => t + m.n(s), 0);
    return { key: m.key, k: m.label, v: arr.length + " z · " + total + " " + m.unit };
  });
  rows.push({ key: "ticks", k: "Ciclos", v: String(snap.ticks) });
  return rows;
}

function railRevision() {
  const res = snap.resources.map((r) =>
    [r.runtime && r.runtime.utilization,
     r.runtime && r.runtime.allocated && r.runtime.allocated.value,
     r.runtime && r.runtime.temperature && r.runtime.temperature.value,
     r.state].join("/")).join(",");
  const feed = feedRows().map((e) => e.source + "@" + e.timestamp).join(",");
  const cov = coverageRows().map((r) => r.v).join(",");
  return res + "|" + feed + "|" + cov;
}

function rowWith(cls, parts) {
  const row = document.createElement("div");
  row.className = cls;
  for (const p of parts) {
    const span = document.createElement("span");
    span.className = p;
    row.append(span);
  }
  return row;
}

/* Sufijo con el que DemoResourceModule marca la telemetria simulada. */
const SIM_SUFFIX = " (SIM)";

function renderTelemetryRail(force) {
  const next = railRevision();
  if (!force && next === rev.rail) return;
  rev.rail = next;

  reconcile(
    els.railRes, resourceRows(), (r) => r.key,
    () => {
      const row = rowWith("res-row", ["res-name", "res-val", "res-extra"]);
      /* La etiqueta SIM va en su propio elemento: el nombre se recorta
         con puntos suspensivos, y un sufijo dentro del mismo texto era
         lo primero que se perdia. */
      const label = document.createElement("span");
      label.className = "res-label";
      const sim = document.createElement("span");
      sim.className = "res-sim";
      row.querySelector(".res-name").append(label, sim);
      const track = document.createElement("span");
      track.className = "res-track";
      const fill = document.createElement("i");
      fill.className = "res-fill";
      track.append(fill);
      row.append(track);
      return row;
    },
    (el, r) => {
      const isSim = r.name.endsWith(SIM_SUFFIX);
      setText(el.querySelector(".res-label"),
        isSim ? r.name.slice(0, -SIM_SUFFIX.length) : r.name);
      setText(el.querySelector(".res-sim"), isSim ? "SIM" : "");
      setText(el.querySelector(".res-val"), r.value);
      setText(el.querySelector(".res-extra"), r.extra);
      setAttr(el, "data-state", r.state);
      /* La barra no tiene transicion: es el dato, y el dato llega
         cada 500 ms. Animarla seria animar el sensor. */
      const fill = el.querySelector(".res-fill");
      const w = r.frac === null ? "0%"
        : Math.round(Math.max(0, Math.min(1, r.frac)) * 100) + "%";
      if (fill.style.width !== w) fill.style.width = w;
    },
  );

  reconcile(
    els.railFeed, feedRows(), (e) => e.source + "@" + e.timestamp,
    () => rowWith("feed-row", ["feed-time", "feed-zone", "feed-type", "feed-conf"]),
    (el, e) => {
      setText(el.querySelector(".feed-time"), String(e.timestamp).slice(11, 19));
      setText(el.querySelector(".feed-zone"), e.zone_id);
      setText(el.querySelector(".feed-type"), e.type);
      setText(el.querySelector(".feed-conf"), (e.confidence || 0).toFixed(2));
      setAttr(el, "data-type", e.type);
    },
  );

  reconcile(
    els.railCov, coverageRows(), (r) => r.key,
    () => rowWith("cov-row", ["cov-k", "cov-v"]),
    (el, r) => {
      setText(el.querySelector(".cov-k"), r.k);
      setText(el.querySelector(".cov-v"), r.v);
    },
  );
}

/* == 6b. MOTION (paso 6) ==================================== */
/* Se anima al operador, no al sensor. Se anima lo que causa una
   persona -- pasar el cursor, elegir una zona -- y lo que ocurre
   una sola vez -- el arranque, un vinculo de corroboracion nuevo.
   Nada de lo que llega cada 500 ms se anima: a esa frecuencia una
   transicion deja de ser respuesta y pasa a ser ruido, 7200 veces
   por hora. */

const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)");

const HOVER_MS = 160;
const PULSE_MS = 700;

const anim = {
  hover: new Map(),   // zoneId -> 0..1
  pulse: new Map(),   // zoneId -> instante de inicio del destello
  last: 0,
};

function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

/* Los tweens avanzan con el dt real del frame, no con un contador de
   frames: a 30 fps una animacion contada por frames dura el doble.
   Devuelve si queda algo en movimiento, que es lo que mantiene vivo
   el bucle de dibujo sin necesidad de un flag global. */
function stepAnim(now) {
  const dt = anim.last ? Math.min(now - anim.last, 100) : 16;
  anim.last = now;
  let busy = false;

  const rate = REDUCED.matches ? 1 : dt / HOVER_MS;
  for (const [id, v] of [...anim.hover]) {
    const target = id === ui.hoverZoneId ? 1 : 0;
    const step = Math.min(rate, Math.abs(target - v));
    const v2 = v + Math.sign(target - v) * step;
    if (v2 !== v) busy = true;
    if (v2 <= 0 && target === 0) anim.hover.delete(id);
    else anim.hover.set(id, v2);
  }
  if (ui.hoverZoneId && !anim.hover.has(ui.hoverZoneId)) {
    anim.hover.set(ui.hoverZoneId, REDUCED.matches ? 1 : 0);
    busy = true;
  }

  for (const [id, t0] of [...anim.pulse]) {
    if (REDUCED.matches || now - t0 >= PULSE_MS) anim.pulse.delete(id);
    busy = true;
  }
  return busy;
}

/* Un vinculo de corroboracion nuevo es un evento raro, y por eso
   puede animarse sin convertirse en ruido. La linea base se siembra
   en el primer snapshot: sin eso, todo lo ya corroborado destellaria
   al cargar la pagina, que es justo lo contrario de "acaba de
   ocurrir". */
let corrSeen = null;

function trackCorroboration() {
  const now = new Set(
    allZoneModels().filter((m) => m.corroborated).map((m) => m.zoneId));
  if (corrSeen) {
    for (const id of now) {
      if (!corrSeen.has(id)) anim.pulse.set(id, performance.now());
    }
  }
  corrSeen = now;
}

/* Destello de corroboracion: un anillo que se expande una vez. Hace
   falta ademas del vinculo porque una zona puede corroborarse por
   respiracion sin tener asociacion espacial que dibujar -- en ese
   caso el anillo es la unica senal de que algo cambio. */
function drawCorrPulse(c, m, x, y, r, dim) {
  const t0 = anim.pulse.get(m.zoneId);
  if (t0 === undefined) return;
  const e = easeOut(Math.min(1, (performance.now() - t0) / PULSE_MS));
  c.save();
  c.globalAlpha = (1 - e) * 0.9 * dim;
  c.strokeStyle = T.life2;
  c.lineWidth = 2 - e;
  c.beginPath();
  c.arc(x, y, r * (1 + e * 1.4), 0, Math.PI * 2);
  c.stroke();
  c.restore();
}

/* La revelacion del dossier ocurre solo al cambiar de zona, que es
   un acto del operador. El panel no parpadea cuando llega evidencia
   nueva: eso pasa cada 500 ms. No hay fase de salida -- retrasar el
   veredicto 110 ms para encadenar un crossfade seria decorar a costa
   de la lectura. */
function revealDossier() {
  if (REDUCED.matches) return;
  const el = els.dossier;
  el.dataset.entering = "true";
  void el.offsetWidth;   // reflow forzado: sin el, el navegador funde ambos estados
  delete el.dataset.entering;
}

/* -- Reconciliacion (paso 4) --------------------------------------
   El defecto del dashboard actual no es la frecuencia del poll: es
   reconstruir listas enteras con innerHTML dos veces por segundo, lo
   que destruye foco, seleccion de texto y scroll. Aqui nada se
   reconstruye; se crea lo nuevo, se borra lo ausente y se escribe
   solo el texto que cambio. */

/* Escribe solo si cambio. Evita invalidar layout por un valor igual,
   que a 2 Hz es la mayoria de las escrituras. */
function setText(el, value) {
  const v = String(value);
  if (el.textContent !== v) el.textContent = v;
}

function setAttr(el, name, value) {
  const v = String(value);
  if (el.getAttribute(name) !== v) el.setAttribute(name, v);
}

/* Reconciliacion por clave: los elementos persisten entre ticks, asi
   que conservan foco y estado. `create` solo corre para claves
   nuevas; `update` escribe valores sobre el nodo que ya existia. */
function reconcile(container, items, keyOf, create, update) {
  const existing = new Map();
  for (const el of [...container.children]) existing.set(el.dataset.key, el);

  const seen = new Set();
  items.forEach((item, i) => {
    const key = String(keyOf(item));
    seen.add(key);
    let el = existing.get(key);
    if (!el) {
      el = create(item);
      el.dataset.key = key;
    }
    update(el, item);
    const at = container.children[i];
    if (at !== el) container.insertBefore(el, at || null);
  });

  for (const [key, el] of existing) if (!seen.has(key)) el.remove();
}

/* -- Dossier (paso 3) ---------------------------------------------
   La prosa la manda el servidor: `interpretation.title` y `summary`
   vienen de explain_zone(), que es la unica autoridad sobre el
   veredicto. Este panel nunca calcula el suyo -- si lo hiciera,
   habria dos definiciones de lo que significa una zona. */

const DOSSIER_SHELL = [
  '<div class="dossier-head">',
  '  <button type="button" class="dossier-close" aria-label="Cerrar dossier">×</button>',
  '  <span class="label" data-f="zone"></span>',
  '  <h2 class="display" data-f="title"></h2>',
  '  <p class="dossier-summary" data-f="summary"></p>',
  '</div>',
  '<section class="dossier-group">',
  '  <h3 class="label">Modalidades</h3>',
  '  <div class="kv" data-f="mods"></div>',
  '</section>',
  '<section class="dossier-group" data-f="briefingSection" hidden>',
  '  <h3 class="label">Informe para el rescatista</h3>',
  '  <p class="dossier-summary" data-f="briefingNarrative"></p>',
  '  <p class="dossier-note dossier-note-warn" data-f="briefingCaveat" hidden></p>',
  '</section>',
  '<section class="dossier-group" data-f="radarSection" hidden>',
  '  <h3 class="label"><span data-f="radarLabel">Retornos de radar</span></h3>',
  '  <div class="radar-list" data-f="radarList"></div>',
  '  <p class="dossier-note" data-f="radarNote" hidden></p>',
  '</section>',
  '<section class="dossier-group">',
  '  <h3 class="label">Estructura</h3>',
  '  <div class="kv"><div class="kv-row">',
  '    <span class="kv-k">Riesgo estructural</span>',
  '    <span class="kv-v"><i class="risk-dot" data-f="riskDot"></i><span data-f="risk"></span></span>',
  '  </div></div>',
  '</section>',
  '<section class="dossier-group">',
  '  <h3 class="label">Índice</h3>',
  '  <div class="kv">',
  '    <div class="kv-row"><span class="kv-k">Índice de evidencia</span>',
  '      <span class="kv-v data" data-f="plife"></span></div>',
  '    <div class="kv-row"><span class="kv-k">log-odds</span>',
  '      <span class="kv-v data" data-f="logodds"></span></div>',
  '  </div>',
  '  <p class="dossier-note">No es una probabilidad calibrada. Representa la fuerza relativa de la evidencia detectada.</p>',
  '</section>',
  '<section class="dossier-group">',
  '  <h3 class="label">Corroboración</h3>',
  '  <div class="kv" data-f="corr"></div>',
  '</section>',
  '<section class="dossier-group">',
  '  <h3 class="label"><span data-f="traceLabel">Trazabilidad</span></h3>',
  '  <div class="trace" data-f="trace"></div>',
  '</section>',
].join("\n");

function dossierRevision() {
  if (!ui.selectedZoneId) {
    const s = missionSummary();
    return "none:" + s.observed + "/" + s.withEvidence + "/" + s.corroborated;
  }
  const m = zoneModel(ui.selectedZoneId);
  const ev = zoneEvidence(ui.selectedZoneId);
  return [
    m.zoneId, m.facts.join("|"), m.stability,
    m.pLife.toFixed(3), (m.zone && m.zone.log_odds || 0).toFixed(3),
    m.associations.length, m.respirationAssociations.length,
    m.radarReturns.map((r) => r.amplitude).join(","),
    ev.length, (ev[0] && ev[0].timestamp) || "",
    (m.briefing && m.briefing.narrative) || "",
  ].join("~");
}

function makeKvRow() {
  const row = document.createElement("div");
  row.className = "kv-row";
  const k = document.createElement("span");
  k.className = "kv-k";
  const v = document.createElement("span");
  v.className = "kv-v";
  row.append(k, v);
  return row;
}

function renderDossier(force) {
  const next = dossierRevision();
  if (!force && next === rev.dossier) return;
  rev.dossier = next;

  if (!ui.selectedZoneId) return renderDossierEmpty();

  const m = zoneModel(ui.selectedZoneId);
  const root = els.dossier;

  /* La cascara se construye una vez por zona. Cambiar de zona es un
     contenido distinto, no una lista que crece: reconstruirla ahi es
     correcto, y hacerlo cada 500 ms no lo seria. */
  if (root.dataset.zone !== m.zoneId) {
    root.innerHTML = DOSSIER_SHELL;
    root.dataset.zone = m.zoneId;
  }

  const f = (name) => root.querySelector('[data-f="' + name + '"]');

  setText(f("zone"), m.zoneId);
  setText(f("title"), (m.interpretation && m.interpretation.title) || "Sin clasificación");
  setText(f("summary"), (m.interpretation && m.interpretation.summary)
    || "VORA no ha producido una interpretación para esta zona.");

  reconcile(
    f("mods"),
    MODS.map((k) => Object.assign({ key: k }, modalityState(m, k))),
    (x) => x.key,
    makeKvRow,
    (el, x) => {
      setText(el.querySelector(".kv-k"), MOD_LABEL[x.key]);
      setText(el.querySelector(".kv-v"), x.text);
      setAttr(el, "data-state", x.state);
      setAttr(el, "data-mod", x.key);
    },
  );

  /* Fase 4: presente solo si StateReaderModule esta compuesto en este
     runtime -- ausente en el resto (`m.briefing === null`) es un
     estado normal, no un error, misma seccion oculta que ya usa
     `radarSection` para su propia ausencia. */
  const briefingSection = f("briefingSection");
  const hasBriefing = Boolean(m.briefing);
  if (briefingSection.hidden !== !hasBriefing) briefingSection.hidden = !hasBriefing;
  if (hasBriefing) {
    setText(f("briefingNarrative"), m.briefing.narrative);
    const caveat = m.briefing.caveats && m.briefing.caveats[0];
    const caveatEl = f("briefingCaveat");
    if (caveatEl.hidden !== !caveat) caveatEl.hidden = !caveat;
    if (caveat) setText(caveatEl, caveat);
  }

  setText(f("risk"), RISK_LABEL[m.stability] || m.stability);
  setAttr(f("riskDot"), "data-risk", m.stability);

  setText(f("plife"), Math.round(m.pLife * 100) + "/100");
  setText(f("logodds"), ((m.zone && m.zone.log_odds) || 0).toFixed(2));

  /* La seccion aparece si hay retornos, no si el hecho
     RESPIRATION_PRESENT esta puesto. Los dos pueden discrepar un tick
     -- el hecho lo decide la clasificacion sobre la ventana de Fusion
     y el retorno viene del ultimo barrido -- y en ese caso lo correcto
     es ensenar la medida, no esconderla detras de la etiqueta. */
  const returns = m.radarReturns.filter((r) => r.position || r.amplitude != null);
  const radarSection = f("radarSection");
  if (radarSection.hidden !== !returns.length) radarSection.hidden = !returns.length;

  if (returns.length) {
    setText(f("radarLabel"), "Retornos de radar (" + returns.length + ")");
    reconcile(
      f("radarList"),
      returns.map((r, i) => ({ r, i })),
      (x) => String(x.i),
      () => {
        const row = document.createElement("div");
        row.className = "radar-row";
        for (const cls of ["radar-k", "radar-amp data", "radar-meta"]) {
          const span = document.createElement("span");
          span.className = cls;
          row.append(span);
        }
        return row;
      },
      (el, x) => {
        setText(el.querySelector(".radar-k"), "Retorno " + (x.i + 1));
        setText(el.querySelector(".radar-amp"), "amplitud " + fmtAmp(x.r.amplitude));
        const pos = fmtPos(x.r.position);
        const ext = x.r.extent
          ? x.r.extent.horizontal_deg.toFixed(1) + "° × " +
            x.r.extent.vertical_deg.toFixed(1) + "°"
          : null;
        setText(el.querySelector(".radar-meta"),
          [ext, pos ? "world " + pos : "sin posición espacial"]
            .filter(Boolean).join("   ·   "));
        setAttr(el, "data-located", Boolean(x.r.position));
      },
    );

    const note = f("radarNote");
    const beyond = radarBeyondSurface(m);
    if (note.hidden !== !beyond) note.hidden = !beyond;
    if (beyond) {
      setText(note,
        "Un retorno cae fuera de la geometría reconstruida por LiDAR. " +
        "No es un error de registro: el radar atraviesa materia y el " +
        "LiDAR se detiene en la primera superficie.");
    }
  }

  const spatial = m.facts.includes("SPATIALLY_CORROBORATED");
  const respir = m.facts.includes("RESPIRATION_CORROBORATED");
  const dist = m.associations.length
    ? m.associations[0].distance_m.toFixed(2) + " m" : null;
  /* Su propio emparejamiento Termica<->Radar, no el de LiDAR<->Termica:
     son pares distintos y confundirlos atribuiria a la respiracion una
     distancia que mide otra cosa. */
  const respirDist = m.respirationAssociations.length
    ? m.respirationAssociations[0].distance_m.toFixed(2) + " m" : null;

  reconcile(
    f("corr"),
    [
      { key: "sp", k: "Espacial", on: spatial, note: spatial && dist ? dist : "" },
      { key: "re", k: "Respiratoria", on: respir,
        note: respir && respirDist ? respirDist : "" },
    ],
    (x) => x.key,
    makeKvRow,
    (el, x) => {
      setText(el.querySelector(".kv-k"), x.k);
      setText(el.querySelector(".kv-v"),
        x.on ? (x.note ? "Sí — " + x.note : "Sí") : "No");
      setAttr(el, "data-state", x.on ? "present" : "empty");
    },
  );

  const ev = zoneEvidence(m.zoneId);
  setText(f("traceLabel"), "Trazabilidad (" + ev.length + ")");

  const trace = f("trace");
  if (!ev.length) {
    if (!trace.querySelector(".dossier-note")) {
      trace.innerHTML =
        '<p class="dossier-note">Ninguna evidencia sobrevive en la ventana activa de Fusion. La zona fue observada.</p>';
    }
    return;
  }
  if (trace.querySelector(".dossier-note")) trace.innerHTML = "";

  reconcile(
    trace,
    ev,
    (e) => e.source + "@" + e.timestamp,
    () => {
      const row = document.createElement("div");
      row.className = "trace-row";
      for (const cls of ["trace-type", "trace-conf data", "trace-time data", "trace-src"]) {
        const span = document.createElement("span");
        span.className = cls;
        row.append(span);
      }
      return row;
    },
    (el, e) => {
      setText(el.querySelector(".trace-type"), e.type);
      setText(el.querySelector(".trace-conf"), (e.confidence || 0).toFixed(2));
      setText(el.querySelector(".trace-time"), String(e.timestamp).slice(11, 19));
      setText(el.querySelector(".trace-src"), String(e.source).split("/").pop());
      setAttr(el, "data-type", e.type);
    },
  );
}

/* Sin seleccion el panel nunca queda vacio: muestra el estado de la
   mision. Un panel en blanco se lee como un fallo. */
function renderDossierEmpty() {
  const s = missionSummary();
  els.dossier.dataset.zone = "";
  els.dossier.innerHTML = [
    '<div class="dossier-head">',
    '  <span class="label">Misión</span>',
    '  <h2 class="display">' + s.withEvidence + " de " + s.observed + ' zonas con evidencia</h2>',
    '  <p class="dossier-summary">Selecciona una zona en el canvas o en el riel para ver su desglose de evidencia y su trazabilidad.</p>',
    '</div>',
    '<section class="dossier-group"><div class="kv">',
    '  <div class="kv-row"><span class="kv-k">Zonas observadas</span><span class="kv-v data">' + s.observed + '</span></div>',
    '  <div class="kv-row" data-state="present"><span class="kv-k">Con evidencia</span><span class="kv-v data">' + s.withEvidence + '</span></div>',
    '  <div class="kv-row" data-state="present"><span class="kv-k">Corroboradas</span><span class="kv-v data">' + s.corroborated + '</span></div>',
    '</div></section>',
  ].join("\n");
}

/* == 7. INTERACTION ========================================= */

/* Hit-testing: distancia al centro proyectado contra el radio del
   disco. Lee de `hitZones`, que es lo que se dibujo, asi que no
   puede discrepar de lo que el operador ve. */
function zoneAt(px, py) {
  let best = null, bestD = Infinity;
  for (const h of hitZones) {
    const d = Math.hypot(px - h.x, py - h.y);
    if (d <= h.r && d < bestD) { best = h.zoneId; bestD = d; }
  }
  if (best) return best;
  const cell = hitZones.find((h) =>
    px >= h.cell.x && px <= h.cell.x + h.cell.w &&
    py >= h.cell.y && py <= h.cell.y + h.cell.h);
  return cell ? cell.zoneId : null;
}

/* Fijar y alternar son actos distintos. Un clic sobre la zona ya
   seleccionada la deselecciona, pero pulsar "3" dos veces tiene que
   dejar la 3 seleccionada, no apagarla. */
function setZone(zoneId) {
  if (ui.selectedZoneId === zoneId) return;
  ui.selectedZoneId = zoneId;
  /* Por debajo de 1280 px el dossier es un panel deslizante, y nada
     lo abria nunca: el CSS esperaba un `data-open` que ningun codigo
     escribia, asi que en una pantalla de portatil corriente el panel
     quedaba fuera de vista y seleccionar una zona no mostraba nada.
     Por encima de ese ancho el atributo no tiene ningun efecto. */
  setAttr(els.dossier, "data-open", Boolean(zoneId));
  ui.dirty = true;
  renderZoneRail(allZoneModels());
  renderDossier(true);   // cambio de zona: se fuerza, no se espera revision
  revealDossier();
}

function selectZone(zoneId) {
  setZone(ui.selectedZoneId === zoneId ? null : zoneId);
}

function bindCanvas() {
  const cv = els.canvas;

  cv.addEventListener("pointerdown", (e) => {
    cv.setPointerCapture(e.pointerId);
    ui.drag = { x: e.clientX, y: e.clientY, moved: 0 };
    const r = cv.getBoundingClientRect();
    ui.pressZoneId = zoneAt(e.clientX - r.left, e.clientY - r.top);
    ui.dirty = true;
  });

  cv.addEventListener("pointermove", (e) => {
    const r = cv.getBoundingClientRect();
    if (!ui.drag) {
      const z = zoneAt(e.clientX - r.left, e.clientY - r.top);
      cv.style.cursor = z ? "pointer" : "grab";
      if (ui.hoverZoneId !== z) { ui.hoverZoneId = z; ui.dirty = true; }
      return;
    }
    const dx = e.clientX - ui.drag.x, dy = e.clientY - ui.drag.y;
    ui.drag.moved += Math.abs(dx) + Math.abs(dy);
    ui.camera.yaw += dx * 0.006;
    ui.camera.pitch = Math.max(-1.2, Math.min(1.2, ui.camera.pitch + dy * 0.005));
    ui.drag.x = e.clientX; ui.drag.y = e.clientY;
    ui.dirty = true;
  });

  cv.addEventListener("pointerleave", () => {
    if (ui.hoverZoneId === null) return;
    ui.hoverZoneId = null;
    ui.dirty = true;
  });

  cv.addEventListener("pointerup", (e) => {
    const wasClick = ui.drag && ui.drag.moved < 4;
    ui.drag = null;
    ui.pressZoneId = null;
    ui.dirty = true;
    if (!wasClick) return;
    const r = cv.getBoundingClientRect();
    const z = zoneAt(e.clientX - r.left, e.clientY - r.top);
    if (z) selectZone(z);
  });

  /* Zoom anclado al cursor: se convierte el cursor a coordenadas
     de mundo, se escala y se compensa la diferencia. Centrar en el
     viewport en cada rueda desplazaria lo que el operador mira. */
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const cam = ui.camera;
    const prev = cam.zoom;
    const next = Math.max(CFG.zoom.min,
      Math.min(CFG.zoom.max, prev * (1 - e.deltaY * CFG.zoom.step)));
    if (next === prev) return;
    const k = next / prev;
    cam.panX = mx - (mx - cam.panX) * k;
    cam.panY = my - (my - cam.panY) * k;
    cam.zoom = next;
    ui.dirty = true;
  }, { passive: false });

  cv.addEventListener("dblclick", resetCamera);

  els.rail.addEventListener("click", (e) => {
    const b = e.target.closest("[data-zone]");
    if (b) selectZone(b.dataset.zone);
  });

  /* Por delegacion: la cascara del dossier se reconstruye al cambiar
     de zona, asi que el manejador no puede colgar del boton. */
  els.dossier.addEventListener("click", (e) => {
    if (e.target.closest(".dossier-close")) setZone(null);
  });
}

/* == 9. TECLADO (paso 7) ==================================== */
/* Un instrumento de campo se maneja con las manos ocupadas y con
   guantes. El teclado no es un atajo para usuarios avanzados: es la
   via de acceso cuando el raton no esta disponible. */

/* Hoy no hay ningun campo de texto en la pantalla. El guard existe
   igual, porque la alternativa es descubrir el dia que se anada un
   buscador que escribir "3" en el salta a la zona 3. */
function isTyping(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

const CAM_HOME = { yaw: -0.5, pitch: 0.34, zoom: 1, panX: 0, panY: 0 };

function resetCamera() {
  Object.assign(ui.camera, CAM_HOME);
  ui.dirty = true;
}

/* "Mas evidencia" no puede significar p_life: satura a 99/100 en tres
   zonas a la vez (R-19), asi que ordenar por ese numero dejaria el
   foco practicamente al azar entre ellas. Se ordena por corroboracion,
   luego por numero de modalidades, y solo entonces por el indice --
   que es el orden en el que la evidencia realmente discrimina. */
function strongestZone() {
  const models = allZoneModels().filter((m) => m.modCount > 0);
  if (!models.length) return null;
  models.sort((a, b) =>
    (b.corroborated - a.corroborated) ||
    (b.modCount - a.modCount) ||
    (b.pLife - a.pLife) ||
    a.zoneId.localeCompare(b.zoneId));
  return models[0].zoneId;
}

function stepZone(delta) {
  const ids = zoneIds();
  if (!ids.length) return;
  const i = ids.indexOf(ui.selectedZoneId);
  setZone(ids[i < 0
    ? (delta > 0 ? 0 : ids.length - 1)
    : (i + delta + ids.length) % ids.length]);
}

/* Mover el foco del DOM a la pastilla, no solo la seleccion: el anillo
   de foco dice donde esta el teclado, y un lector de pantalla lo
   anuncia. Es posible porque el riel ya no se reconstruye. */
function focusPill(zoneId) {
  if (!zoneId) return;
  const pill = els.rail.querySelector('[data-zone="' + zoneId + '"]');
  if (pill && document.activeElement !== pill) pill.focus();
}

function bindKeyboard() {
  window.addEventListener("keydown", (e) => {
    if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key >= "1" && e.key <= "9") {
      const z = zoneIds()[Number(e.key) - 1];
      if (!z) return;
      setZone(z);
      focusPill(z);
      e.preventDefault();
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        stepZone(1); focusPill(ui.selectedZoneId); break;
      case "ArrowUp":
        stepZone(-1); focusPill(ui.selectedZoneId); break;
      case "Escape":
        setZone(null); break;
      case "r": case "R":
        resetCamera(); break;
      case "f": case "F": {
        const z = strongestZone();
        if (z) { setZone(z); focusPill(z); }
        break;
      }
      default:
        return;
    }
    e.preventDefault();   // las flechas no deben desplazar la pagina
  });
}

/* == 10. ESTADOS DEGRADADOS (paso 7) ======================== */
/* Perder el enlace no borra nada. Lo que hay en pantalla es el ultimo
   estado conocido y sigue siendo informacion util: se congela, se
   desatura y se rotula con su edad. Vaciar la pantalla al perder la
   conexion destruiria justo lo que el operador necesita mientras
   decide si avanza. */
function renderLinkState() {
  const state = LINK_STATES[ui.link];
  setAttr(document.body, "data-severity", state.severity);
  const showBanner = state.banner !== null;
  if (els.banner.hidden === showBanner) els.banner.hidden = !showBanner;
  if (!showBanner) return;

  setText(els.bannerLabel, state.banner);
  setText(els.bannerAge, state.detail());
}

/* Reticula de espera. Un canvas vacio debe leerse como un instrumento
   encendido sin cobertura todavia, no como una pantalla rota: el
   centro se deja libre para el rotulo en HTML. */
function drawReticle(c, w, h) {
  const step = 48;
  c.save();
  c.strokeStyle = T.line;
  c.lineWidth = 1;
  c.beginPath();
  for (let x = step; x < w; x += step) { c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, h); }
  for (let y = step; y < h; y += step) { c.moveTo(0, y + 0.5); c.lineTo(w, y + 0.5); }
  c.stroke();
  c.strokeStyle = T.lineStrong;
  c.beginPath();
  c.arc(w / 2, h / 2, Math.min(w, h) * 0.28, 0, Math.PI * 2);
  c.stroke();
  c.restore();
}

/* == 8. BOOT ================================================ */

/* El canvas se dibuja en rAF, desacoplado del poll: el poll marca
   el estado sucio, el frame decide si hay algo que repintar. */
function frame(now) {
  /* Un tween en curso mantiene el bucle repintando sin necesidad de
     un flag global: mientras algo se mueva, `busy` es cierto, y al
     terminar el canvas vuelve a quedarse quieto. */
  const busy = stepAnim(now || performance.now());
  if (ui.dirty || busy) {
    ui.dirty = false;
    draw();
    renderCommandBar();
  }
  /* Fuera del guard de `dirty`: el dossier y el riel tienen su propia
     revision, que cambia cuando llega evidencia nueva aunque el
     canvas no necesite repintarse. */
  renderDossier(false);
  renderTelemetryRail(false);
  /* Fuera del guard: la edad del ultimo dato avanza aunque no haya
     llegado nada -- que es exactamente el caso que hay que rotular. */
  renderLinkState();
  requestAnimationFrame(frame);
}

function boot() {
  cacheEls();
  loadTokens();
  resizeCanvas();
  bindCanvas();
  bindKeyboard();

  /* ResizeObserver sobre el stage, no solo window.resize: el canvas
     tambien cambia de ancho cuando el dossier colapsa por breakpoint,
     y eso no dispara un resize de ventana. */
  new ResizeObserver(resizeCanvas).observe(els.canvas.parentElement);
  window.addEventListener("resize", resizeCanvas);

  /* Pegar el enlace nuevo en la misma pestana solo cambia el fragmento:
     el navegador no recarga y startSession() no volveria a correr, asi
     que la pagina seguiria en "sesion no valida" con el enlace bueno
     delante. Un fragmento nuevo abre la sesion de nuevo. */
  window.addEventListener("hashchange", () => {
    startSession().then(poll);
  });

  /* rAF se congela en una pestana no visible -- correcto, ahorra
     bateria, y es exactamente lo que se quiere en un equipo de campo.
     Pero al volver, el ultimo frame pedido nunca se sirvio: hay que
     marcar sucio para repintar en lugar de mostrar un lienzo viejo.
     Detectado verificando: el panel no componia frames y el canvas
     quedaba en negro con el estado ya cargado. */
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) ui.dirty = true;
  });

  /* El intervalo arranca despues de abrir la sesion: un sondeo que se
     adelantara a la cookie recibiria 401 y marcaria "sesion no valida" un
     instante. */
  startSession().then(poll).then(() => {
    renderZoneRail(allZoneModels());
    renderDossier(true);
    renderTelemetryRail(true);
    setInterval(async () => {
      const before = zoneIds().join();
      await poll();
      if (zoneIds().join() !== before) renderZoneRail(allZoneModels());
    }, CFG.pollMs);
  });

  requestAnimationFrame(frame);
}

/* boot() (poll + canvas + dossier) no arranca hasta que el splash
   (mission.js) resuelve Nueva/Continuar -- antes de eso no hay
   mision de cliente que mostrar, y arrancar el canvas contra cero
   seleccion seria trabajo tirado. El propio backend (QueenDemoRuntime)
   ya viene corriendo desde antes de que esta pagina cargue; lo unico
   que el splash retrasa es cuando ESTA pestana empieza a mirarlo. */
document.addEventListener("DOMContentLoaded", () => initSplash(boot));
