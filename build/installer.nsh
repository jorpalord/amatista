!include "nsDialogs.nsh"
!include "WinMessages.nsh"

; Vars de la pagina custom de carpeta de datos -- guardadas bajo
; BUILD_UNINSTALLER (igual que las funciones mas abajo) porque installer.nsh
; se incluye tanto para el instalador como el desinstalador, y una Var
; declarada pero jamas usada en la pasada del desinstalador tira warning
; 6001 ("not referenced or never set"), que electron-builder trata como
; error (confirmado real).
;
; ${StrCase} (Hallazgo 1, 4ta revision externa,
; docs/_arch/verify_installer_data_preservation_design.md -- mayusculizar
; para comparar rutas Windows de forma case-insensitive, real: usa
; User32::CharUpper internamente, no una reimplementacion propia) va guardada
; ACA TAMBIEN por el mismo motivo real -- confirmado real, sin este guard el
; build fallaba: "install function StrCase not referenced" en la pasada del
; desinstalador (unico uso real es dentro de DataFolderPageLeave, guardada
; mas abajo, nunca invocada en esa pasada).
!ifndef BUILD_UNINSTALLER
Var DataFolderDialog
Var DataFolderText
Var DataFolder

!include "StrFunc.nsh"
${StrCase}
!endif

!ifndef BUILD_UNINSTALLER
!macro customInit
  ; A partir de v0.4.7 Amatista dejo de permitir elegir donde guarda sus
  ; datos (ver historial de este archivo) -- se reintroduce en Fase 1
  ; (docs/_arch/verify_installer_data_folder_design.md), esta vez escribiendo
  ; a AMATISTA_STORAGE_ROOT (la variable que src/main/app-paths.ts YA lee
  ; hoy), no al nombre viejo y muerto AMATISTA_DATA_DIR.
  ;
  ; Lo unico que sigue siendo elegible por el usuario aparte de la carpeta de
  ; datos es DONDE VIVE EL PROGRAMA ($INSTDIR, via la pagina estandar de
  ; NSIS, porque allowToChangeInstallationDirectory sigue en true). Ese
  ; default tambien se saca de C:\ aqui:
  StrCpy $INSTDIR "D:\AMATISTA\app"

  ; Default de la carpeta de datos: mismo valor que el fallback hardcodeado
  ; en app-paths.ts cuando no hay override por env var.
  StrCpy $DataFolder "D:\AMATISTA\data"
!macroend
!endif

; Pagina custom (nsDialogs) para elegir la carpeta de datos. Se muestra
; despues de elegir donde vive el programa ($INSTDIR) y antes de copiar
; archivos -- "customPageAfterChangeDir" es el hook que electron-builder
; expone para esto (ver node_modules/app-builder-lib/templates/nsis/
; assistedInstaller.nsh).
;
; Todo este bloque (macro + funciones) va guardado bajo BUILD_UNINSTALLER
; igual que customInit: installer.nsh se incluye TANTO para compilar el
; instalador COMO el desinstalador (2 pasadas de makensis), y en la pasada
; del desinstalador "customPageAfterChangeDir" nunca se invoca -- si las
; funciones quedan definidas sin guardar, NSIS tira "function not
; referenced" y electron-builder trata ese warning como error (confirmado
; real: hizo fallar el build hasta agregar este guard).
!ifndef BUILD_UNINSTALLER
!macro customPageAfterChangeDir
  Page custom DataFolderPageCreate DataFolderPageLeave
!macroend

Function DataFolderPageCreate
  nsDialogs::Create 1018
  Pop $DataFolderDialog

  ${If} $DataFolderDialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 12u "Elegi la carpeta donde Amatista va a guardar sus datos:"
  Pop $0

  ${NSD_CreateText} 0 16u 68% 12u "$DataFolder"
  Pop $DataFolderText

  ${NSD_CreateBrowseButton} 70% 15u 30% 13u "Examinar..."
  Pop $0
  ${NSD_OnClick} $0 OnBrowseDataFolderClick

  ; Sin checkbox "misma carpeta que la instalacion" -- eliminado a proposito
  ; (Hallazgo 1, 4ta revision externa): su sola existencia habilitaba el
  ; estado peligroso (datos reales mezclados con el desinstalador de
  ; electron-builder, que borra $INSTDIR entero al desinstalar/actualizar,
  ; RMDir /r sin ninguna excepcion). La validacion de DataFolderPageLeave
  ; (mas abajo) ya rechaza igual, activamente, cualquier intento de elegir
  ; $INSTDIR o una subcarpeta suya a mano -- el estado peligroso ya no puede
  ; crearse por ningun camino, ni con un click ni tipeando.

  nsDialogs::Show
FunctionEnd

Function OnBrowseDataFolderClick
  nsDialogs::SelectFolderDialog "Elegi la carpeta de datos" "$DataFolder"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $DataFolderText "$0"
  ${EndIf}
FunctionEnd

; Hallazgo 1 de la 4ta revision externa (docs/_arch/
; verify_installer_data_preservation_design.md): validacion real en el
; ORIGEN -- la carpeta de datos nunca puede ser $INSTDIR ni una subcarpeta
; real de $INSTDIR (si lo fuera, el desinstalador estandar de
; electron-builder, RMDir /r $INSTDIR sin ninguna excepcion -- confirmado
; real leyendo node_modules/app-builder-lib/templates/nsis/uninstaller.nsh
; -- borraria los datos del usuario, tanto al desinstalar como en cada
; actualizacion normal via el flujo silencioso uninstallOldVersion). Unico
; punto de validacion (cubre tipear a mano Y usar "Examinar", ambos caminos
; terminan escribiendo al mismo campo de texto antes de llegar aca) --
; corre al intentar avanzar de pagina ("Siguiente"), Abort real cancela la
; transicion y deja al usuario en la misma pagina para corregir (mismo
; mecanismo ya usado en DataFolderPageCreate si nsDialogs::Create falla).
;
; Mismo principio que isWithinFolder() (TypeScript, fix de la 3ra revision
; externa): comparacion ingenua de substring falla (ej. "D:\AMATISTA\app"
; NUNCA deberia matchear como prefijo real de "D:\AMATISTA\appExtra", que
; es una carpeta HERMANA, no una subcarpeta) -- el prefijo de comparacion
; incluye el separador "\" a proposito. Windows es case-insensitive para
; rutas -- ${StrCase} normaliza a MAYUSCULAS antes de comparar (real, usa
; User32::CharUpper internamente, no una reimplementacion propia).
Function DataFolderPageLeave
  ${NSD_GetText} $DataFolderText $DataFolder

  ${StrCase} $1 "$DataFolder" "U"
  ${StrCase} $2 "$INSTDIR" "U"

  ; Sacar backslash final de los 2 lados si lo hay (el usuario puede tipear
  ; "D:\ruta\" con barra final; $INSTDIR normalmente no la trae) -- para que
  ; la comparacion de igualdad/prefijo de abajo sea pareja.
  StrLen $3 $1
  IntOp $3 $3 - 1
  StrCpy $4 $1 1 $3
  ${If} $4 == "\"
    StrCpy $1 $1 $3
  ${EndIf}

  StrLen $3 $2
  IntOp $3 $3 - 1
  StrCpy $4 $2 1 $3
  ${If} $4 == "\"
    StrCpy $2 $2 $3
  ${EndIf}

  ; Caso 1: coincidencia EXACTA con la carpeta de instalacion.
  ${If} $1 == $2
    MessageBox MB_OK|MB_ICONEXCLAMATION "La carpeta de datos no puede ser la misma que la carpeta de instalacion -- elegi una ubicacion distinta."
    Abort
  ${EndIf}

  ; Caso 2: subcarpeta REAL de la carpeta de instalacion (prefijo con
  ; separador incluido -- "D:\AMATISTA\APP\" es prefijo real de
  ; "D:\AMATISTA\APP\DATA", pero NUNCA de "D:\AMATISTA\APPEXTRA").
  StrCpy $3 "$2\"
  StrLen $4 $3
  StrCpy $5 $1 $4
  ${If} $5 == $3
    MessageBox MB_OK|MB_ICONEXCLAMATION "La carpeta de datos no puede estar dentro de la carpeta de instalacion -- elegi una ubicacion distinta."
    Abort
  ${EndIf}
FunctionEnd
!endif

!macro customInstall
  ; Escribe la carpeta de datos elegida en la MISMA variable de entorno que
  ; src/main/app-paths.ts ya lee hoy. Nunca AMATISTA_DATA_DIR (ver
  ; customUnInstall abajo) -- reusar ese nombre crearia un segundo canal
  ; paralelo, uno real y uno muerto.
  WriteRegStr HKCU "Environment" "AMATISTA_STORAGE_ROOT" "$DataFolder"

  ; Broadcast para que procesos nuevos (Amatista arrancando por primera vez
  ; despues del instalador) vean la variable sin necesitar cerrar sesion de
  ; Windows.
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro customUnInstall
  ; Limpieza de restos de instalaciones v0.4.6 y anteriores (marker file +
  ; env var de registro del selector de datos que ya no existe).
  Delete "$INSTDIR\amatista-data-dir.txt"
  DeleteRegValue HKCU "Environment" "AMATISTA_DATA_DIR"
!macroend
