; Registers Cutout with Windows for images (png, jpg, jpeg, gif, webp, svg) so it appears in
; "Open with" and "Choose another app", without changing the user's default apps.
; Windows 11 only lists desktop apps there that are registered with Default Apps
; (RegisteredApplications → Capabilities → FileAssociations), so this does that plus the
; older OpenWithProgids / Applications entries.
; Included by electron-builder (build resources folder "installer"). Per-user install, so HKCU.

; Sharp text on high-resolution screens: without this, Windows stretches the installer window and it looks blurry.
ManifestDPIAware true

!define CUTOUT_EXE "$INSTDIR\Cutout.exe"
!define CUTOUT_CAPS "Software\Cutout\Capabilities"

!macro CutoutAddType EXT
  WriteRegStr HKCU "Software\Classes\${EXT}\OpenWithProgids" "Cutout.Image" ""
  WriteRegStr HKCU "Software\Classes\Applications\Cutout.exe\SupportedTypes" "${EXT}" ""
  WriteRegStr HKCU "${CUTOUT_CAPS}\FileAssociations" "${EXT}" "Cutout.Image"
!macroend

!macro CutoutRemoveType EXT
  DeleteRegValue HKCU "Software\Classes\${EXT}\OpenWithProgids" "Cutout.Image"
!macroend

!macro customInstall
  ; File type (ProgID)
  WriteRegStr HKCU "Software\Classes\Cutout.Image" "" "Image"
  WriteRegStr HKCU "Software\Classes\Cutout.Image" "FriendlyTypeName" "Image"
  WriteRegStr HKCU "Software\Classes\Cutout.Image\DefaultIcon" "" "${CUTOUT_EXE},0"
  WriteRegStr HKCU "Software\Classes\Cutout.Image\shell\open" "FriendlyAppName" "Cutout"
  WriteRegStr HKCU "Software\Classes\Cutout.Image\shell\open\command" "" '"${CUTOUT_EXE}" "%1"'
  WriteRegStr HKCU "Software\Classes\Cutout.Image\Application" "ApplicationName" "Cutout"
  WriteRegStr HKCU "Software\Classes\Cutout.Image\Application" "ApplicationIcon" "${CUTOUT_EXE},0"
  WriteRegStr HKCU "Software\Classes\Cutout.Image\Application" "ApplicationCompany" "Cutout"
  ; Application entry
  WriteRegStr HKCU "Software\Classes\Applications\Cutout.exe" "FriendlyAppName" "Cutout"
  WriteRegStr HKCU "Software\Classes\Applications\Cutout.exe\DefaultIcon" "" "${CUTOUT_EXE},0"
  WriteRegStr HKCU "Software\Classes\Applications\Cutout.exe\shell\open\command" "" '"${CUTOUT_EXE}" "%1"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\Cutout.exe" "" "${CUTOUT_EXE}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\Cutout.exe" "Path" "$INSTDIR"
  ; Default Apps registration
  WriteRegStr HKCU "${CUTOUT_CAPS}" "ApplicationName" "Cutout"
  WriteRegStr HKCU "${CUTOUT_CAPS}" "ApplicationDescription" "A lightweight raster scratchpad for designers"
  WriteRegStr HKCU "${CUTOUT_CAPS}" "ApplicationIcon" "${CUTOUT_EXE},0"
  WriteRegStr HKCU "Software\RegisteredApplications" "Cutout" "${CUTOUT_CAPS}"
  !insertmacro CutoutAddType ".png"
  !insertmacro CutoutAddType ".jpg"
  !insertmacro CutoutAddType ".jpeg"
  !insertmacro CutoutAddType ".gif"
  !insertmacro CutoutAddType ".webp"
  !insertmacro CutoutAddType ".svg"
  ; SHCNE_ASSOCCHANGED: tell Explorer to reload associations
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  !insertmacro CutoutRemoveType ".png"
  !insertmacro CutoutRemoveType ".jpg"
  !insertmacro CutoutRemoveType ".jpeg"
  !insertmacro CutoutRemoveType ".gif"
  !insertmacro CutoutRemoveType ".webp"
  !insertmacro CutoutRemoveType ".svg"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Cutout"
  DeleteRegKey HKCU "Software\Cutout"
  DeleteRegKey HKCU "Software\Classes\Cutout.Image"
  DeleteRegKey HKCU "Software\Classes\Applications\Cutout.exe"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\Cutout.exe"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
