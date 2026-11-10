/* ==============================================================
   VORA OS - Splash y sesion de mision (minimo viable, solo cliente)

   No existe todavia un backend de misiones: QueenDemoRuntime corre
   una unica simulacion continua desde que arranca el proceso, y el
   snapshot que sirve nunca trajo un identificador de mision -- ver
   el propio comentario de app.js en `ingest()`: "El snapshot no
   lleva id de mision, asi que ese campo se retira en vez de
   rellenarse con un valor inventado". Este archivo no cambia eso.
   Lo que construye, sobre ese mismo backend siempre encendido, es
   un identificador y un resumen de sesion puramente de cliente, en
   localStorage, para que "Nueva mision" / "Continuar mision
   anterior" tengan algo real que hacer sin tocar composition root
   ni el ciclo de vida real de MissionManager -- que es justo lo que
   esta pagina no debe tocar.

   Que se persiste (todo bajo una sola clave de localStorage,
   `vora.mission.v1`, como un objeto JSON):
     - id          string, generado con crypto.randomUUID()
     - startedAt   ISO timestamp de cuando se eligio "Nueva mision"
     - lastSeenAt  ISO timestamp, actualizado en cada snapshot real
                   recibido del servidor mientras el dashboard esta
                   abierto (heartbeatMission(), llamado desde
                   app.js::ingest())
     - summary     {scanned, withEvidence, corroborated, ticks} --
                   copia de `zone_summary`/`ticks` del ultimo
                   snapshot recibido. Solo para mostrar "como quedo"
                   en la nota de "Continuar" -- no es un historial,
                   no es una traza de entrenamiento, no sobrevive a
                   un `localStorage.clear()` ni se sincroniza entre
                   pestanas/dispositivos.

   Deliberadamente NO persistido (fuera de alcance de este archivo):
   la nube de puntos, el registro de evidencia, cualquier cosa que
   requiera mas que un objeto pequeno -- ver el propio limite de
   `MAX_EVIDENCE_LOG` en bridge.py para la misma disciplina de "poco
   y con proposito" aplicada del lado del servidor.
   ============================================================== */

const MISSION_STORAGE_KEY = "vora.mission.v1";

function loadStoredMission() {
  try {
    const raw = localStorage.getItem(MISSION_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    // localStorage bloqueado (privado, cuota, etc.) -- la sesion
    // sigue funcionando, solo no persiste entre recargas.
    return null;
  }
}

function saveStoredMission(mission) {
  try {
    localStorage.setItem(MISSION_STORAGE_KEY, JSON.stringify(mission));
  } catch {
    // idem -- fallo silencioso y no fatal.
  }
  return mission;
}

function newMissionId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "m-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function startNewMission() {
  const now = new Date().toISOString();
  return saveStoredMission({ id: newMissionId(), startedAt: now, lastSeenAt: now, summary: null });
}

/* Llamado desde app.js::ingest() en cada snapshot real recibido --
   nunca desde un timer propio, para no persistir mas seguido de lo
   que el servidor realmente produce datos nuevos. */
function heartbeatMission(zoneSummary, ticks) {
  const mission = loadStoredMission();
  if (!mission) return; // sin "Nueva"/"Continuar" todavia (splash activo) -- nada que actualizar
  mission.lastSeenAt = new Date().toISOString();
  if (zoneSummary) {
    mission.summary = {
      scanned: zoneSummary.scanned ?? 0,
      withEvidence: zoneSummary.with_evidence ?? 0,
      corroborated: zoneSummary.multimodal_corroboration ?? 0,
      ticks: ticks ?? 0,
    };
  }
  saveStoredMission(mission);
}

function fmtRelativeTime(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "hace un momento";
  if (m < 60) return "hace " + m + " min";
  const h = Math.floor(m / 60);
  return "hace " + h + " h " + (m % 60) + " min";
}

function missionSummaryNote(mission) {
  const s = mission.summary;
  const base = "Misión " + mission.id.slice(0, 8) + " · iniciada " + fmtRelativeTime(mission.startedAt);
  if (!s) return base + " · sin datos registrados todavía";
  return base + " · " + s.withEvidence + " de " + s.scanned + " zonas con evidencia" +
    (s.corroborated ? " · " + s.corroborated + " corroboradas" : "");
}

/* == Splash =================================================== */

/* `onEnter(mission)` arranca app.js::boot() -- ver el final de este
   archivo. Separado de `boot()` a propósito: mission.js no sabe
   nada del canvas/dossier/poll, solo decide *cuándo* empiezan. */
function initSplash(onEnter) {
  const splash = document.getElementById("splash");
  const btnNew = document.getElementById("splash-new");
  const btnContinue = document.getElementById("splash-continue");
  const note = document.getElementById("splash-continue-note");

  const stored = loadStoredMission();
  if (stored) {
    btnContinue.disabled = false;
    note.textContent = missionSummaryNote(stored);
  } else {
    btnContinue.disabled = true;
    note.textContent = "No hay ninguna misión guardada todavía en este navegador.";
  }

  function enter(mission) {
    splash.classList.add("splash-leaving");
    // Espera a que termine la transición de salida antes de ocultarlo
    // del árbol de accesibilidad -- desaparecer de golpe bajo la
    // animación se leería como un parpadeo, no como una salida.
    window.setTimeout(() => { splash.hidden = true; }, 420);
    onEnter(mission);
  }

  btnNew.addEventListener("click", () => enter(startNewMission()));

  btnContinue.addEventListener("click", () => {
    const mission = loadStoredMission();
    if (!mission) return; // botón deshabilitado en este caso -- defensivo, no debería dispararse
    mission.lastSeenAt = new Date().toISOString();
    enter(saveStoredMission(mission));
  });
}

/* == Limitaciones de uso ======================================
   audit-2026-09-28.md §6/§3D -- el texto completo vive en index.html
   (no generado aquí, para que sea auditable como markup estático, no
   como una cadena dentro de JS). Esta función solo abre/cierra el
   panel; independiente de initSplash/boot() a propósito, para que el
   botón funcione incluso si algo más en la página falla en arrancar. */
function initUsageDisclaimer() {
  const btn = document.getElementById("usage-disclaimer");
  const panel = document.getElementById("usage-panel");
  const closeBtn = document.getElementById("usage-panel-close");

  function open() {
    panel.hidden = false;
    closeBtn.focus();
  }
  function close() {
    panel.hidden = true;
    btn.focus();
  }

  btn.addEventListener("click", open);
  closeBtn.addEventListener("click", close);
  panel.addEventListener("click", (e) => {
    if (e.target === panel) close(); // clic fuera del cuadro de texto
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) close();
  });
}

document.addEventListener("DOMContentLoaded", initUsageDisclaimer);
