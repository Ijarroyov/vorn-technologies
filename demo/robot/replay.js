/* Reproducción de una simulación REAL de VORA OS.
   frames.json contiene instantáneas de /api/state grabadas del propio panel
   (QueenDemoRuntime, escenario de 4 zonas), una por segundo. Este script
   sustituye solo la red: el panel (app.js) es el mismo. Al terminar la
   grabación se repite la última ventana con reloj y ticks crecientes, para
   que el panel no la marque como congelada. */
(function () {
  const realFetch = window.fetch.bind(window);
  let frames = null, loading = null, t0 = null;
  const WINDOW = 25;
  const load = () => loading || (loading = realFetch("frames.json").then(r => r.json()).then(f => { frames = f; }));
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", "X-Vora-Boot": "replay" },
  });
  function stateAt(sec) {
    const n = frames.length, last = frames[n - 1].t;
    let src, extra = 0;
    if (sec <= last) src = frames.find((f, i) => f.t >= sec || i === n - 1);
    else {
      const w0 = frames[Math.max(0, n - WINDOW)].t, span = last - w0 || 1;
      const k = Math.floor((sec - w0) / span), pos = w0 + ((sec - w0) % span);
      src = frames.find(f => f.t >= pos) || frames[n - 1]; extra = k;
    }
    const s = JSON.parse(JSON.stringify(src.state));
    if (extra) {
      const dt = frames[n - 1].t - frames[Math.max(0, n - WINDOW)].t || 1;
      const dTicks = (frames[n - 1].state.ticks - frames[Math.max(0, n - WINDOW)].state.ticks);
      s.ticks += extra * dTicks; s.uptime_s += extra * dt; s.sim_uptime_s += extra * dt;
    }
    return s;
  }
  window.fetch = async function (url, opts) {
    const u = String(url);
    if (u.startsWith("/api/session")) return json({ ok: true });
    if (u.startsWith("/api/state")) {
      await load(); if (t0 === null) t0 = performance.now();
      return json(stateAt((performance.now() - t0) / 1000));
    }
    return realFetch(url, opts);
  };
})();
