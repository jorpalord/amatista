/**
 * mascot-embed.js — Mascota Q como componente decorativo puro.
 * Sin window.qRobot (Electron IPC), sin fetch/WebSocket a backend.
 * Requiere: mascot.js ya cargado (expone window.Mascot).
 */
(() => {
  if (window.Mascot) Mascot.setState("idle");

  const FUN_STATES = [
    { state: "idle",      dur: 15000 },
    { state: "spinning",  dur:  4000 },
    { state: "idle",      dur: 12000 },
    { state: "happy",     dur:  3500 },
    { state: "idle",      dur: 20000 },
    { state: "sleeping",  dur:  8000 },
    { state: "idle",      dur: 15000 },
    { state: "working",   dur:  4000 },
    { state: "idle",      dur: 18000 },
    { state: "printing",  dur:  3500 },
    { state: "idle",      dur: 20000 },
    { state: "thinking",  dur:  4000 },
    { state: "idle",      dur: 14000 },
    { state: "scared",    dur:  2500 },
    { state: "idle",      dur: 18000 },
    { state: "angry",     dur:  3500 },
    { state: "idle",      dur: 20000 },
    { state: "transform", dur:  4000 },
  ];
  let funIdx = 0;

  function scheduleFun() {
    const entry = FUN_STATES[funIdx % FUN_STATES.length];
    funIdx++;
    if (window.Mascot) Mascot.setAnim(entry.state);
    setTimeout(scheduleFun, entry.dur);
  }

  setTimeout(scheduleFun, 2000); // arranca corto: no hay handshake de backend que esperar
})();
