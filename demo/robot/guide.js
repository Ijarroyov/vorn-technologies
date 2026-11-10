/* Guía de lectura de la demostración: explica qué se ve en el panel.
   Solo añade una capa; no toca el motor del panel (app.js). Se abre sola al elegir «Nueva misión»
   y se puede volver a abrir con «¿Qué estoy viendo?». */
(function () {
  const STEPS = [
    {
      t: 'Qué es esto',
      p: 'El panel de mando de VORA OS reproduciendo una simulación grabada de un edificio colapsado. No es una misión en vivo ni hay un robot físico: es el software, trabajando con sensores simulados.',
    },
    {
      t: 'Las zonas',
      p: 'Cada círculo es una zona del edificio (Z-A, Z-B…). Los anillos de color son los sensores que aportaron evidencia: LiDAR en azul, térmica en naranja y radar en violeta. El centro verde muestra la evidencia de vida: cuanto más brillante, más fuerte.',
    },
    {
      t: 'Toca una zona',
      p: 'Al elegirla se abre su ficha a la derecha: qué evidencia hay, de qué sensor viene y su índice de vida, de 0 a 100. Es la fuerza de la evidencia, no una probabilidad ni una confirmación de que haya una persona.',
    },
    {
      t: 'La franja de abajo',
      p: 'Recursos: el uso simulado de procesador y memoria. Evidencia en vivo: lo último que van detectando los sensores. Cobertura: qué sensores han barrido cada zona.',
    },
    {
      t: 'Lo que no es',
      p: 'VORA OS ayuda a decidir dónde buscar primero. No es un diagnóstico médico ni sustituye la inspección de una persona de rescate: toda evidencia requiere verificación humana.',
    },
  ];

  const $ = (id) => document.getElementById(id);
  const box = $('guide'), count = $('guide-count'), title = $('guide-title'), text = $('guide-text');
  const prev = $('guide-prev'), next = $('guide-next');
  let i = 0;

  function render() {
    count.textContent = 'Guía · ' + (i + 1) + ' de ' + STEPS.length;
    title.textContent = STEPS[i].t;
    text.textContent = STEPS[i].p;
    prev.disabled = i === 0;
    next.textContent = i === STEPS.length - 1 ? 'Entendido' : 'Siguiente';
  }
  function open(at) {
    i = at || 0;
    render();
    box.hidden = false;
    next.focus({ preventScroll: true });
  }
  function close() {
    box.hidden = true;
    $('guide-open').focus({ preventScroll: true });
  }

  prev.addEventListener('click', function () { if (i > 0) { i--; render(); } });
  next.addEventListener('click', function () { if (i < STEPS.length - 1) { i++; render(); } else close(); });
  $('guide-close').addEventListener('click', close);
  $('guide-open').addEventListener('click', function () { open(0); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !box.hidden) close(); });

  // Se abre sola cuando la persona entra a la misión (cierra el splash).
  let shown = false;
  function autoOpen() { if (shown) return; shown = true; setTimeout(function () { open(0); }, 500); }
  ['splash-new', 'splash-continue'].forEach(function (id) {
    const b = $(id);
    if (b) b.addEventListener('click', autoOpen);
  });
  const splash = $('splash');
  if (!splash || splash.hidden || getComputedStyle(splash).display === 'none') autoOpen();
})();
