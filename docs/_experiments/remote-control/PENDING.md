# PENDING.md — Remote Control (experimento)

## HECHO — Parte 2: la app nativa de Android (verificada en emulador)

`android/remote-viewer/`, ver `CONTRACT.md` §9: emparejamiento real de punta a punta, pinning contra un impostor, reconexión con `Last-Event-ID` sin pérdida, e interfaz con datos reales. Sin commit.

## ABIERTO — Prueba con un teléfono físico

Lo que el emulador no puede probar (`CONTRACT.md` §9.6):
1. **Escanear con la cámara** el QR de la pantalla de la PC.
2. **Keystore respaldado por hardware:** en la pantalla de chats tiene que decir StrongBox o TEE, no "software".
3. **Firewall de Windows:** una conexión entrante desde otro dispositivo de la Wi-Fi. La primera vez que Amatista escucha en la red local, Windows puede pedir permiso para `Amatista.exe` en redes **privadas**; si no aparece o se rechazó, el teléfono no llega.
4. **Corte real:** apagar la Wi-Fi del teléfono en medio de un turno real de un modelo y volver.

Cómo instalar el APK de depuración: `android/remote-viewer/app/build/outputs/apk/debug/app-debug.apk`, con `adb install` o copiándolo al teléfono (requiere permitir apps de origen desconocido).

## ABIERTO — Decisiones del usuario

Ver `CONTRACT.md` §6 (revisado con §1.4). Estado tras la Parte 2:
1. **Transporte:** primer paso **resuelto**, la misma Wi-Fi con HTTPS propio (decisión del usuario). Tailscale sin `serve` queda como opción posterior e intercambiable (`bindAddress` en `remote-access.json`).
2. **Cliente del teléfono:** **resuelto**, app nativa en Kotlin + Compose, sin WebView (Parte 2, `CONTRACT.md` §9.1).
3. **Credencial:** token hasheado en F0. ¿Clave no extraíble en el Keystore para F1?
4. **Aprobaciones pendientes en el teléfono:** **resuelto**, título completo (decisión del usuario).
5. **Apagado automático:** implementado de forma conservadora, **arranca apagado en cada inicio** (solo se recuerda el consentimiento). Confirmar o pedir otra política.
6. **Adjuntos en F0:** sin miniaturas (solo nombre, tipo y tamaño).
7. **Historial "en vuelo":** **resuelto**, copia del `eventLog` + anillo con secuencia. Mover el guardado al motor sigue fuera de alcance.

## ABIERTO — `safeStorage` y `Local State`: una instalación nueva que se cierra de golpe pierde la clave maestra

Encontrado en el E2E de la Parte 1 (`CONTRACT.md` §8.2). Chromium guarda la clave maestra de `safeStorage` en `Local State` recién al cerrar ordenadamente. Si un perfil **nuevo** se mata antes (`taskkill /F`, un corte de luz), lo cifrado en esa sesión ya no se puede descifrar:
- la clave del certificado del acceso remoto, que **falla cerrado**: identidad nueva y hay que volver a emparejar;
- **y, desde antes de este experimento, las API keys**.

Posible mitigación: forzar la escritura de `Local State` apenas se cifra algo por primera vez. Hay que investigarlo aparte.

## ABIERTO — Hueco de historial: los mensajes los guarda la interfaz, no el motor

Encontrado al diseñar F0 (`CONTRACT.md` §2.4). La Parte 1 lo cubre con la copia del `eventLog` y el anillo. Cerrarlo de raíz (guardar en el proceso principal) es un cambio del flujo central de sesiones, a decidir aparte.

## Fases posteriores (fuera de F0)

- **F1 — control:** mandar, cancelar y responder; aprobaciones blandas desde el teléfono; subir adjuntos (`attachments:fromDataUrl`); clave no extraíble obligatoria.
- **Mejoras:**
  - vencimiento automático de dispositivos por inactividad (30 días, §4.3, no implementado);
  - redescubrir la IP de la PC cuando cambia (hoy hay que volver a escanear el QR);
  - seguir en vivo más de los 50 chats más recientes (límite actual del stream en la app);
  - notificaciones con la app cerrada del todo (hoy las da el servicio en primer plano mientras está conectada);
  - build de release firmado de la app;
  - transporte fuera de casa (Tailscale sin `serve`, o WireGuard directo).
