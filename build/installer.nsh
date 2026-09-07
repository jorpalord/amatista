!include "nsDialogs.nsh"
!include "WinMessages.nsh"

; Vars de la pagina custom de carpeta de datos -- guardadas bajo
; BUILD_UNINSTALLER (igual que las funciones mas abajo) porque installer.nsh
; se incluye tanto para el instalador como el desinstalador, y una Var
; declarada pero jamas usada en la pasada del desinstalador tira warning
; 6001 ("not referenced or never set"), que electron-builder trata como
; error (confirmado real).
!ifndef BUILD_UNINSTALLER
Var DataFolderDialog
Var DataFolderText
Var SameFolderCheckbox
Var DataFolder
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

  ${NSD_CreateCheckbox} 0 36u 100% 12u "Usar la misma carpeta que la instalacion"
  Pop $SameFolderCheckbox

  nsDialogs::Show
FunctionEnd

Function OnBrowseDataFolderClick
  nsDialogs::SelectFolderDialog "Elegi la carpeta de datos" "$DataFolder"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $DataFolderText "$0"
  ${EndIf}
FunctionEnd

Function DataFolderPageLeave
  ${NSD_GetState} $SameFolderCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $DataFolder "$INSTDIR"
  ${Else}
    ${NSD_GetText} $DataFolderText $DataFolder
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
