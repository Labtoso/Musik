; Musik is now Streyn. The new name installs into a new folder, so an old Musik
; installation is removed with its own uninstaller. Its settings move over on the first start.
!macro NSIS_HOOK_POSTINSTALL
  ${If} ${FileExists} "$LOCALAPPDATA\Musik\uninstall.exe"
    ExecWait '"$LOCALAPPDATA\Musik\uninstall.exe" /S _?=$LOCALAPPDATA\Musik'
    Delete "$LOCALAPPDATA\Musik\uninstall.exe"
    RMDir "$LOCALAPPDATA\Musik"
  ${EndIf}
!macroend
