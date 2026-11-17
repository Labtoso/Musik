; Windows installer hooks (used by the release build through --config, see .github/workflows/build.yml).

; Before the files are copied: the offline-mode server that the app starts can still be running
; even after the app itself was closed, and Windows does not let a running program be replaced.
; Close it the same way the installer closes the app (it asks first in the normal installer).
!macro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "$INSTDIR\streyn-server.exe" "Streyn Server"
!macroend

; Musik is now Streyn. The new name installs into a new folder, so an old Musik
; installation is removed with its own uninstaller.
!macro NSIS_HOOK_POSTINSTALL
  ${If} ${FileExists} "$LOCALAPPDATA\Musik\uninstall.exe"
    ExecWait '"$LOCALAPPDATA\Musik\uninstall.exe" /S _?=$LOCALAPPDATA\Musik'
    Delete "$LOCALAPPDATA\Musik\uninstall.exe"
    RMDir "$LOCALAPPDATA\Musik"
  ${EndIf}
!macroend

; Uninstalling: the offline-mode server has to be closed as well before its file can go.
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CheckIfAppIsRunning "$INSTDIR\streyn-server.exe" "Streyn Server"
!macroend
