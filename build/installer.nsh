!ifndef BUILD_UNINSTALLER
!macro customInit
  ; A partir de v0.4.7 Amatista ya no permite elegir donde guarda sus datos:
  ; el proceso main hardcodea D:\AMATISTA\data (ver src/main/app-paths.ts) y
  ; nunca degrada a C:\. La antigua pagina "elige carpeta de datos" quedaba
  ; muerta (el codigo ya no lee AMATISTA_DATA_DIR), asi que se elimino junto
  ; con este macro para no confundir con un selector que no hacia nada.
  ;
  ; Lo unico que sigue siendo elegible por el usuario es DONDE VIVE EL
  ; PROGRAMA ($INSTDIR, via la pagina estandar de NSIS, porque
  ; allowToChangeInstallationDirectory sigue en true). Ese default tambien
  ; se saca de C:\ aqui:
  StrCpy $INSTDIR "D:\AMATISTA\app"
!macroend
!endif

!macro customUnInstall
  ; Limpieza de restos de instalaciones v0.4.6 y anteriores (marker file +
  ; env var de registro del selector de datos que ya no existe).
  Delete "$INSTDIR\amatista-data-dir.txt"
  DeleteRegValue HKCU "Environment" "AMATISTA_DATA_DIR"
!macroend
