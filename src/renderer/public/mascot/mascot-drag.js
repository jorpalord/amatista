/**
 * mascot-drag.js — Arrastre del contenedor de la mascota por toda la ventana.
 * Todo escuchado sobre el propio contenedor (pointer capture), nunca sobre
 * document — esa fue la falla real del robot-ui.js original de q-mascot
 * (mousedown/mousemove en document con preventDefault incondicional rompía
 * el click en el resto de la app).
 * Expone window.initMascotDrag(containerEl) → función de cleanup.
 */
(() => {
  function initMascotDrag(container) {
    if (!container || container.dataset.dragInit === "1") return null; // evita doble-init bajo StrictMode
    container.dataset.dragInit = "1";

    const THRESHOLD = 6;
    let down = false, dragging = false;
    let startX = 0, startY = 0;
    let originLeft = 0, originTop = 0;

    const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

    function onPointerDown(e) {
      if (e.button !== 0) return;
      down = true; dragging = false;
      startX = e.clientX; startY = e.clientY;
      const rect = container.getBoundingClientRect();
      originLeft = rect.left; originTop = rect.top;
      container.setPointerCapture(e.pointerId);
    }

    function onPointerMove(e) {
      if (!down) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!dragging && (Math.abs(dx) > THRESHOLD || Math.abs(dy) > THRESHOLD)) {
        dragging = true;
        container.classList.add("mascot-dragging");
      }
      if (!dragging) return;

      const maxLeft = Math.max(0, window.innerWidth - container.offsetWidth);
      const maxTop  = Math.max(0, window.innerHeight - container.offsetHeight);

      container.style.left = clamp(originLeft + dx, 0, maxLeft) + "px";
      container.style.top  = clamp(originTop + dy, 0, maxTop) + "px";
    }

    function onPointerUp(e) {
      if (!down) return;
      down = false;
      dragging = false;
      container.classList.remove("mascot-dragging");
      try { container.releasePointerCapture(e.pointerId); } catch {}
    }

    // Si la ventana se redimensiona, recortar para que no quede fuera de vista
    function onResize() {
      const rect = container.getBoundingClientRect();
      const maxLeft = Math.max(0, window.innerWidth - container.offsetWidth);
      const maxTop  = Math.max(0, window.innerHeight - container.offsetHeight);
      container.style.left = clamp(rect.left, 0, maxLeft) + "px";
      container.style.top  = clamp(rect.top, 0, maxTop) + "px";
    }

    container.addEventListener("pointerdown", onPointerDown);
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerup", onPointerUp);
    container.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("resize", onResize);

    return function cleanup() {
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerup", onPointerUp);
      container.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("resize", onResize);
      delete container.dataset.dragInit;
    };
  }

  window.initMascotDrag = initMascotDrag;
})();
