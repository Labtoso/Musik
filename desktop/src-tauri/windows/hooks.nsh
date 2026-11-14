; Musik is now Streyn. The new name installs into a new folder, so the old Musik
; installation is removed here. Its settings stay and move over on the first start.
!macro NSIS_HOOK_POSTINSTALL
  ${If} ${FileExists} "$LOCALAPPDATA\Musik\uninstall.exe"
    ExecWait '"$LOCALAPPDATA\Musik\uninstall.exe" /S _?=$LOCALAPPDATA\Musik'
    Delete "$LOCALAPPDATA\Musik\uninstall.exe"
    ; The updater of the old app starts its old file once more after installing.
    ; Put Streyn there for that one start: it opens the real Streyn and removes the folder.
    CreateDirectory "$LOCALAPPDATA\Musik"
    CopyFiles /SILENT "$INSTDIR\${MAINBINARYNAME}.exe" "$LOCALAPPDATA\Musik\musik-desktop.exe"
    CopyFiles /SILENT "$INSTDIR\${MAINBINARYNAME}.exe" "$LOCALAPPDATA\Musik\Musik.exe"
  ${EndIf}
!macroend
