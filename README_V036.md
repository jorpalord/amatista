# Universal Agent Studio V0.3.6

Corrección crítica de UI:
- el composer ya no participa del flujo vertical del grid;
- queda anclado al fondo del área principal;
- solo los mensajes hacen scroll;
- se reserva espacio inferior para no tapar mensajes;
- cambiar workspace/fullscreen ya no puede expulsar el composer;
- se agregó botón visible para entrar y salir de pantalla completa.

Prueba:
```powershell
npm run typecheck
npm run dev
```

Luego:
1. selecciona workspace;
2. cambia varias veces;
3. entra a Pantalla completa;
4. sal con `Salir pantalla completa`;
5. el composer debe permanecer visible siempre.
