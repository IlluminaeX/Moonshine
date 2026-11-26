; Moonshine installer: the Moonshine app, its stream player (Moonlight) and its host engine
; (Moonshine's Apollo build), all inside one folder. Built by scripts/package.ps1, which passes
; VERSION, STAGE and OUTFILE.
;
; There are no choices to make: Welcome -> Installing -> Finish.
;   - The host engine goes to $INSTDIR\host and runs as the "Moonshine Host" service.
;   - A separately installed Apollo is moved in first (settings, apps, login, paired devices) and
;     then removed, so there is one app and nothing has to pair again. See prepare-host.ps1.
;
; The installer window is drawn Moonshine's way instead of the stock wizard layout: one background
; image across the whole window (stars, with the eclipse behind the content), text straight on top
; of it, and flat buttons of our own. Windows' Back / Next / Cancel buttons are moved out of sight;
; ours press them. While files are being installed there are no buttons at all, because nothing can
; be clicked then. The uninstaller keeps the plain dark wizard.

Unicode true
!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "WinMessages.nsh"
!include "x64.nsh"
!include "LogicLib.nsh"

Name "Moonshine"
OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\Moonshine"
!ifdef PREVIEW
  ; makensis /DPREVIEW builds a look-only copy: no admin, and installing just waits a moment.
  RequestExecutionLevel user
!else
  RequestExecutionLevel admin
!endif
SetCompressor /SOLID lzma
; A large window lets LZMA find repeats across the whole app (about 6% smaller than the 8 MB
; default). Unpacking needs this much memory while installing, which any PC that streams has.
SetCompressorDictSize 192
SetFont "Segoe UI" 9
BrandingText " "
ShowInstDetails nevershow
ShowUninstDetails nevershow
AutoCloseWindow true ; go straight from installing to the finish page

!define APOLLO_DIR "$PROGRAMFILES64\Apollo" ; where a separate Apollo lives, if there is one
!define HOST_DIR "$INSTDIR\host"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Moonshine"
!define INVITE_RULE "Moonshine invites (Tailscale)"
!define TUNNEL_RULE "Moonshine direct connections"

; Moonshine's palette (app/renderer/style.css). COLORREF values are 0x00BBGGRR.
!define BG "15101D"
!define TEXT "F4EEEF"
!define MUTED "B6A6BD"
!define ACCENT "DC143C"
!define RING_OFF "6B5A78"
!define SURFACE "231B2E"
!define BG_REF 0x001D1015
!define SURFACE_REF 0x002E1B23
!define ACCENT_REF 0x003C14DC

Var HostPlan ; fresh | update | migrate
Var PlanText
Var DesktopShortcut ; 1 or 0, from the tick-boxes on the first page
Var StartShortcut
; The tick-boxes: a rounded ring, a rounded fill inside it (crimson with a tick when on), and a text line
Var DesktopRing
Var DesktopFill
Var DesktopText
Var StartRing
Var StartFill
Var StartText
Var CheckFont
Var ReadyText
Var WinW ; the window's inside, in pixels
Var WinH
Var BgImage ; the background bitmap, loaded at that size
Var TitleFont
Var ButtonFont

!define MUI_ICON "${STAGE}\moonshine\resources\app\assets\moonshine.ico"
!define MUI_UNICON "${STAGE}\moonshine\resources\app\assets\moonshine.ico"
!define MUI_BGCOLOR "${BG}"
!define MUI_TEXTCOLOR "${TEXT}"
!define MUI_INSTFILESPAGE_COLORS "${TEXT} ${BG}"
!define MUI_CUSTOMFUNCTION_GUIINIT InstallerFrame
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.DarkFrame

Page custom WelcomePage
!define MUI_PAGE_CUSTOMFUNCTION_SHOW InstFilesShow
!insertmacro MUI_PAGE_INSTFILES
Page custom FinishPage

!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.ConfirmShow
!insertmacro MUI_UNPAGE_CONFIRM
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.InstFilesShow
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; ---- Window helpers -------------------------------------------------------------------

; Dark title bar and frame. Runs once when the window is created.
!macro DARK_FRAME
  ; DWMWA_USE_IMMERSIVE_DARK_MODE (Windows 10 20H1+) and DWMWA_CAPTION_COLOR (Windows 11).
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i ${BG_REF}, i 4)'
  SetCtlColors $HWNDPARENT ${TEXT} ${BG}
!macroend

; A place in the window, given in thousandths of its width and height (so the layout follows any
; display scaling). Leaves x, y, width, height in $R1..$R4.
!macro PLACE X Y W H
  IntOp $R1 $WinW * ${X}
  IntOp $R1 $R1 / 1000
  IntOp $R2 $WinH * ${Y}
  IntOp $R2 $R2 / 1000
  IntOp $R3 $WinW * ${W}
  IntOp $R3 $R3 / 1000
  IntOp $R4 $WinH * ${H}
  IntOp $R4 $R4 / 1000
!macroend

; Stretches the page in $0 over the whole window and puts the background image behind its controls.
!macro PAGE_BACKGROUND
  System::Call 'user32::SetWindowPos(p $0, p 0, i 0, i 0, i $WinW, i $WinH, i 0x14)' ; no z-order change, no activate
  ; A picture control (SS_BITMAP) the size of the window, with WS_CLIPSIBLINGS so it never paints over
  ; the page's other controls. Those sit on parts of the picture that are plain background, and are
  ; filled with that same colour.
  System::Call 'user32::CreateWindowEx(i 0, t "STATIC", t "", i 0x5400000E, i 0, i 0, i $WinW, i $WinH, p $0, p 0, p 0, p 0) p .r9'
  SendMessage $9 0x0172 0 $BgImage ; STM_SETIMAGE, IMAGE_BITMAP
!macroend

; Call once the page's controls exist: sends the picture (in $9) to the back of the stacking order.
!macro BACKGROUND_BEHIND
  System::Call 'user32::SetWindowPos(p $9, p 1, i 0, i 0, i 0, i 0, i 0x13)' ; HWND_BOTTOM
!macroend

; Text on the background (on a page made with nsDialogs), filled with the background colour.
!macro TEXT_LABEL X Y W H COLOR FONT TEXT
  !insertmacro PLACE ${X} ${Y} ${W} ${H}
  ${NSD_CreateLabel} $R1 $R2 $R3 $R4 "${TEXT}"
  Pop $R5
  !if "${FONT}" != ""
    SendMessage $R5 ${WM_SETFONT} ${FONT} 0
  !endif
  SetCtlColors $R5 ${COLOR} ${BG}
!macroend

; A flat, rounded button of our own: a clickable text label with a solid fill.
!macro FLAT_BUTTON X Y W H FILL TEXT HANDLER
  !insertmacro PLACE ${X} ${Y} ${W} ${H}
  ${NSD_CreateLabel} $R1 $R2 $R3 $R4 "${TEXT}"
  Pop $R5
  ${NSD_AddStyle} $R5 0x201 ; SS_CENTER | SS_CENTERIMAGE: text centred both ways
  SendMessage $R5 ${WM_SETFONT} $ButtonFont 0
  SetCtlColors $R5 FFFFFF ${FILL}
  IntOp $R6 $R3 + 1
  IntOp $R7 $R4 + 1
  IntOp $R8 $R4 / 3 ; corner size follows the button's height
  System::Call 'gdi32::CreateRoundRectRgn(i 0, i 0, i $R6, i $R7, i $R8, i $R8) p .r8'
  System::Call 'user32::SetWindowRgn(p $R5, p $8, i 1)'
  ${NSD_OnClick} $R5 ${HANDLER}
!macroend

Function InstallerFrame
  !insertmacro DARK_FRAME

  ; The window's inside, in pixels.
  System::Call 'user32::GetClientRect(p $HWNDPARENT, @ r0)'
  System::Call '*$0(i, i, i .r1, i .r2)'
  StrCpy $WinW $1
  StrCpy $WinH $2

  ; The background, from the prepared size nearest above the window's (see scripts/gen-installer-art.js).
  InitPluginsDir
  ${If} $WinW <= 500
    File "/oname=$PLUGINSDIR\bg.bmp" "bg-500.bmp"
  ${ElseIf} $WinW <= 625
    File "/oname=$PLUGINSDIR\bg.bmp" "bg-625.bmp"
  ${ElseIf} $WinW <= 750
    File "/oname=$PLUGINSDIR\bg.bmp" "bg-750.bmp"
  ${ElseIf} $WinW <= 875
    File "/oname=$PLUGINSDIR\bg.bmp" "bg-875.bmp"
  ${Else}
    File "/oname=$PLUGINSDIR\bg.bmp" "bg-1000.bmp"
  ${EndIf}
  System::Call 'user32::LoadImage(p 0, t "$PLUGINSDIR\bg.bmp", i 0, i $WinW, i $WinH, i 0x10) p .s' ; IMAGE_BITMAP, LR_LOADFROMFILE
  Pop $BgImage

  CreateFont $TitleFont "Segoe UI Semibold" 20 600
  CreateFont $ButtonFont "Segoe UI Semibold" 10 600
  CreateFont $CheckFont "Segoe UI Symbol" 10 700

  ; Windows' own Back / Next / Cancel go off-screen (they still work when ours press them), and the
  ; wizard's header, divider lines and branding text are hidden.
  ${For} $0 1 3
    GetDlgItem $1 $HWNDPARENT $0
    System::Call 'user32::SetWindowPos(p $1, p 0, i -4000, i -4000, i 0, i 0, i 0x15)'
  ${Next}
  ${ForEach} $0 1028 1256 + 1
    ${If} $0 == 1028
    ${OrIf} $0 == 1034
    ${OrIf} $0 == 1035
    ${OrIf} $0 == 1036
    ${OrIf} $0 == 1037
    ${OrIf} $0 == 1038
    ${OrIf} $0 == 1039
    ${OrIf} $0 == 1045
    ${OrIf} $0 == 1256
      GetDlgItem $1 $HWNDPARENT $0
      ShowWindow $1 ${SW_HIDE}
    ${EndIf}
  ${Next}
FunctionEnd

Function OnNextClick
  Pop $0
  SendMessage $HWNDPARENT ${WM_COMMAND} 1 0 ; Windows' Next / Install / Close button
FunctionEnd

Function OnCancelClick
  Pop $0
  SendMessage $HWNDPARENT ${WM_CLOSE} 0 0
FunctionEnd

Function OnOpenClick
  Pop $0
  !ifndef PREVIEW
    Exec '"$INSTDIR\Moonshine.exe"'
  !endif
  SendMessage $HWNDPARENT ${WM_COMMAND} 1 0
FunctionEnd

; Tick-boxes of our own, to match the buttons. Off: a soft outline around a dark centre. On: filled
; crimson with a white tick. Clicking the box or its text switches it.
!define TICK "${U+2713}"

; One row. Y is where it sits (thousandths of the window height); the three controls go in RING, FILL, TEXTCTL.
!macro CHECK_ROW Y RING FILL TEXTCTL LABEL HANDLER
  !insertmacro PLACE 80 ${Y} 440 60
  IntOp $R6 $WinH * 52
  IntOp $R6 $R6 / 1000 ; the box's size in pixels
  IntOp $R7 $R6 / 8 ; the outline's width
  IntOp $R8 $R6 - $R7
  IntOp $R8 $R8 - $R7 ; the fill's size
  ${NSD_CreateLabel} $R1 $R2 $R6 $R6 ""
  Pop $R5
  StrCpy ${RING} $R5
  IntOp $R9 $R6 / 3
  IntOp $0 $R6 + 1
  System::Call 'gdi32::CreateRoundRectRgn(i 0, i 0, i $0, i $0, i $R9, i $R9) p .r8'
  System::Call 'user32::SetWindowRgn(p $R5, p $8, i 1)'
  ${NSD_OnClick} $R5 ${HANDLER}
  IntOp $R3 $R1 + $R7
  IntOp $R4 $R2 + $R7
  ${NSD_CreateLabel} $R3 $R4 $R8 $R8 ""
  Pop $R5
  StrCpy ${FILL} $R5
  ${NSD_AddStyle} $R5 0x201 ; centred both ways, for the tick
  SendMessage $R5 ${WM_SETFONT} $CheckFont 0
  IntOp $R9 $R8 / 3
  IntOp $0 $R8 + 1
  System::Call 'gdi32::CreateRoundRectRgn(i 0, i 0, i $0, i $0, i $R9, i $R9) p .r8'
  System::Call 'user32::SetWindowRgn(p $R5, p $8, i 1)'
  ${NSD_OnClick} $R5 ${HANDLER}
  !insertmacro PLACE 80 ${Y} 440 60
  IntOp $R3 $R1 + $R6
  IntOp $R3 $R3 + $R6 ; a gap as wide as the box
  IntOp $2 $WinW * 440
  IntOp $2 $2 / 1000
  IntOp $2 $2 - $R6
  IntOp $2 $2 - $R6 ; the text gets what is left of the row
  ${NSD_CreateLabel} $R3 $R2 $2 $R6 "${LABEL}"
  Pop $R5
  StrCpy ${TEXTCTL} $R5
  ${NSD_AddStyle} $R5 0x200 ; text centred up and down against the box
  SetCtlColors $R5 ${TEXT} ${BG}
  ${NSD_OnClick} $R5 ${HANDLER}
!macroend

; Paint one box on or off.
!macro PAINT_CHECK RING FILL STATE
  ${If} ${STATE} == 1
    SetCtlColors ${RING} FFFFFF ${ACCENT}
    SetCtlColors ${FILL} FFFFFF ${ACCENT}
    ${NSD_SetText} ${FILL} "${TICK}"
  ${Else}
    SetCtlColors ${RING} FFFFFF ${RING_OFF}
    SetCtlColors ${FILL} FFFFFF ${SURFACE}
    ${NSD_SetText} ${FILL} ""
  ${EndIf}
  System::Call 'user32::InvalidateRect(p ${RING}, p 0, i 1)'
  System::Call 'user32::InvalidateRect(p ${FILL}, p 0, i 1)'
!macroend

Function ShowShortcutBoxes
  !insertmacro PAINT_CHECK $DesktopRing $DesktopFill $DesktopShortcut
  !insertmacro PAINT_CHECK $StartRing $StartFill $StartShortcut
FunctionEnd

Function OnDesktopBoxClick
  Pop $0
  IntOp $DesktopShortcut 1 - $DesktopShortcut
  Call ShowShortcutBoxes
FunctionEnd

Function OnStartBoxClick
  Pop $0
  IntOp $StartShortcut 1 - $StartShortcut
  Call ShowShortcutBoxes
FunctionEnd

Function WelcomePage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  !insertmacro PAGE_BACKGROUND
  !insertmacro TEXT_LABEL 80 120 480 130 ${TEXT} $TitleFont "Moonshine"
  !insertmacro TEXT_LABEL 80 280 470 60 ${TEXT} "" "Stream your games to friends, and play on theirs."
  !insertmacro TEXT_LABEL 80 380 440 200 ${MUTED} "" "$PlanText"
  !insertmacro CHECK_ROW 610 $DesktopRing $DesktopFill $DesktopText "Add a desktop shortcut" OnDesktopBoxClick
  !insertmacro CHECK_ROW 680 $StartRing $StartFill $StartText "Add a Start menu shortcut" OnStartBoxClick
  Call ShowShortcutBoxes
  !insertmacro FLAT_BUTTON 80 800 210 95 ${ACCENT} "Install" OnNextClick
  !insertmacro FLAT_BUTTON 310 800 170 95 ${SURFACE} "Cancel" OnCancelClick
  !insertmacro BACKGROUND_BEHIND
  nsDialogs::Show
FunctionEnd

; The installing page is NSIS's own; restyle it in place.
Function InstFilesShow
  FindWindow $0 "#32770" "" $HWNDPARENT
  SetCtlColors $0 ${TEXT} ${BG}
  !insertmacro PAGE_BACKGROUND

  !insertmacro PLACE 80 120 480 130
  System::Call 'user32::CreateWindowEx(i 0, t "STATIC", t "Installing Moonshine", i 0x50000000, i $R1, i $R2, i $R3, i $R4, p $0, p 0, p 0, p 0) p .r5'
  SendMessage $5 ${WM_SETFONT} $TitleFont 0
  SetCtlColors $5 ${TEXT} ${BG}

  ; What it's doing right now. Its text changes, so it keeps a solid fill (this part of the picture is plain).
  GetDlgItem $1 $0 1006
  !insertmacro PLACE 80 690 560 65
  System::Call 'user32::SetWindowPos(p $1, p 0, i $R1, i $R2, i $R3, i $R4, i 0x14)'
  SetCtlColors $1 ${MUTED} ${BG}

  ; A slim crimson progress bar on a dark track.
  GetDlgItem $1 $0 1004
  !insertmacro PLACE 80 780 840 22
  System::Call 'user32::SetWindowPos(p $1, p 0, i $R1, i $R2, i $R3, i $R4, i 0x14)'
  System::Call 'uxtheme::SetWindowTheme(p $1, w " ", w " ")' ; unthemed, so it takes our colours
  SendMessage $1 0x0409 0 ${ACCENT_REF} ; PBM_SETBARCOLOR
  SendMessage $1 0x2001 0 ${SURFACE_REF} ; PBM_SETBKCOLOR
  !insertmacro BACKGROUND_BEHIND
  System::Call 'user32::InvalidateRect(p $0, p 0, i 1)'
FunctionEnd

Function FinishPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  !insertmacro PAGE_BACKGROUND
  !insertmacro TEXT_LABEL 80 120 480 130 ${TEXT} $TitleFont "Moonshine is ready"
  ${If} $DesktopShortcut == 1
  ${AndIf} $StartShortcut == 1
    StrCpy $ReadyText "It's in the Start menu and on your desktop."
  ${ElseIf} $DesktopShortcut == 1
    StrCpy $ReadyText "It's on your desktop."
  ${ElseIf} $StartShortcut == 1
    StrCpy $ReadyText "It's in the Start menu."
  ${Else}
    StrCpy $ReadyText "You'll find it in $INSTDIR."
  ${EndIf}
  !insertmacro TEXT_LABEL 80 280 440 300 ${MUTED} "" "$ReadyText Moonshine keeps running in the tray so your devices and friends can connect."
  !insertmacro FLAT_BUTTON 80 800 270 95 ${ACCENT} "Open Moonshine" OnOpenClick
  !insertmacro FLAT_BUTTON 370 800 170 95 ${SURFACE} "Close" OnNextClick
  !insertmacro BACKGROUND_BEHIND
  nsDialogs::Show
FunctionEnd

; ---- Uninstaller: the plain dark wizard ---------------------------------------------------

; Colours for the current inner page, and hide the etched divider lines. Runs on every page.
!macro DARK_PAGE
  FindWindow $0 "#32770" "" $HWNDPARENT
  SetCtlColors $0 ${TEXT} ${BG}
  ; 1035/1045: lines above the buttons, 1036: line under the header, 1256: branding text.
  ${ForEach} $1 1035 1045 + 1
    ${If} $1 == 1035
    ${OrIf} $1 == 1036
    ${OrIf} $1 == 1045
      GetDlgItem $2 $HWNDPARENT $1
      ShowWindow $2 ${SW_HIDE}
    ${EndIf}
  ${Next}
  GetDlgItem $2 $HWNDPARENT 1256
  ShowWindow $2 ${SW_HIDE}
!macroend

Function un.DarkFrame
  !insertmacro DARK_FRAME
  ; Windows' own dark style for the Back / Next / Cancel buttons.
  ${For} $0 1 3
    GetDlgItem $1 $HWNDPARENT $0
    System::Call 'uxtheme::SetWindowTheme(p $1, w "DarkMode_Explorer", p 0)'
  ${Next}
FunctionEnd

Function un.ConfirmShow
  !insertmacro DARK_PAGE
  FindWindow $0 "#32770" "" $HWNDPARENT
  ${ForEach} $1 1000 1029 + 1
    GetDlgItem $2 $0 $1
    ${If} $2 <> 0
      SetCtlColors $2 ${TEXT} ${BG}
    ${EndIf}
  ${Next}
FunctionEnd

Function un.InstFilesShow
  !insertmacro DARK_PAGE
  FindWindow $0 "#32770" "" $HWNDPARENT
  GetDlgItem $1 $0 1006
  SetCtlColors $1 ${MUTED} ${BG}
  GetDlgItem $1 $0 1004
  System::Call 'uxtheme::SetWindowTheme(p $1, w " ", w " ")' ; unthemed, so it takes our colours
  SendMessage $1 0x0409 0 ${ACCENT_REF} ; PBM_SETBARCOLOR
  SendMessage $1 0x2001 0 ${SURFACE_REF} ; PBM_SETBKCOLOR
FunctionEnd

; ---- Install --------------------------------------------------------------------------

!ifdef PREVIEW
Section "-Preview" SEC_APP
  DetailPrint "Installing Moonshine..."
  ${For} $0 1 20
    Sleep 150
  ${Next}
SectionEnd
Section "-Preview host" SEC_HOST
  DetailPrint "Installing the host..."
  Sleep 1500
SectionEnd
!else

Section "-Moonshine app" SEC_APP
  ; Close a running Moonshine and stop its host so their files can be replaced.
  DetailPrint "Closing Moonshine..."
  nsExec::ExecToLog /TIMEOUT=30000 'taskkill /im Moonshine.exe /f'
  nsExec::ExecToLog /TIMEOUT=90000 'net stop MoonshineHost'

  ; Move a separate Apollo in (then remove it), and put the host in managed mode.
  ; Run with 64-bit PowerShell and a time limit, so this step can never leave the installer stuck;
  ; what it did is written to install.log.
  ${If} $HostPlan == "migrate"
    DetailPrint "Moving your Apollo settings into Moonshine..."
  ${EndIf}
  CreateDirectory "$INSTDIR"
  InitPluginsDir
  File "/oname=$PLUGINSDIR\prepare-host.ps1" "prepare-host.ps1"
  ; 64-bit PowerShell is in System32 for a 64-bit installer (what MSYS2's NSIS builds), and reached
  ; through the Sysnative alias from a 32-bit one. Sysnative only exists for 32-bit programs.
  StrCpy $1 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${If} ${FileExists} "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
    StrCpy $1 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
  nsExec::ExecToLog /TIMEOUT=300000 '"$1" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\prepare-host.ps1" -HostDir "${HOST_DIR}" -ApolloDir "${APOLLO_DIR}" -LogFile "$INSTDIR\install.log"'
  Pop $0
  ${If} $0 == "timeout"
    ; Its important steps come first and are quick, so carry on; the log shows where it stopped.
    DetailPrint "Preparing the host took too long; continuing."
  ${ElseIf} $0 != "0"
    ; Never let this fail unnoticed: leave a line in the log saying it did not run properly.
    FileOpen $2 "$INSTDIR\install.log" a
    FileSeek $2 0 END
    FileWrite $2 "prepare-host did not finish normally (result: $0, PowerShell: $1)$\r$\n"
    FileClose $2
  ${EndIf}

  DetailPrint "Installing Moonshine..."
  ; The stream player and app code are replaced whole, so files from an older version
  ; (a different player build, removed scripts) can't linger and get loaded.
  RMDir /r "$INSTDIR\moonlight"
  RMDir /r "$INSTDIR\resources\app"
  RMDir /r "$INSTDIR\locales" ; older versions shipped every language
  SetOutPath "$INSTDIR"
  File /r "${STAGE}\moonshine\*.*"

  ; Older versions had an invite service with its own firewall rule; it is part of the host now.
  nsExec::ExecToLog /TIMEOUT=180000 'netsh advfirewall firewall delete rule name="${INVITE_RULE}"'

  ; Direct connections to and from friends' PCs arrive as UDP from the internet (hole punching), so
  ; Moonshine may receive them without Windows asking. Deleted first so reinstalls don't stack copies.
  nsExec::ExecToLog /TIMEOUT=180000 'netsh advfirewall firewall delete rule name="${TUNNEL_RULE}"'
  nsExec::ExecToLog /TIMEOUT=180000 'netsh advfirewall firewall add rule name="${TUNNEL_RULE}" dir=in action=allow program="$INSTDIR\Moonshine.exe" protocol=UDP enable=yes profile=any'

  ; An unticked box also removes that shortcut if an earlier install made it.
  ${If} $StartShortcut == 1
    CreateShortcut "$SMPROGRAMS\Moonshine.lnk" "$INSTDIR\Moonshine.exe" "" "$INSTDIR\Moonshine.exe" 0
  ${Else}
    Delete "$SMPROGRAMS\Moonshine.lnk"
  ${EndIf}
  ${If} $DesktopShortcut == 1
    CreateShortcut "$DESKTOP\Moonshine.lnk" "$INSTDIR\Moonshine.exe" "" "$INSTDIR\Moonshine.exe" 0
  ${Else}
    Delete "$DESKTOP\Moonshine.lnk"
  ${EndIf}
  ; Shortcuts from an earlier install may still show the cached old icon; ask Explorer to refresh.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayName" "Moonshine"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "Publisher" "Moonshine"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\Moonshine.exe"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoRepair" 1
  DeleteRegValue HKLM "${UNINSTALL_KEY}" "ManagesApollo" ; from installers that kept Apollo separate

  ; moonshine://join/... links (invites) open Moonshine, even before it has been run once
  WriteRegStr HKCR "moonshine" "" "URL:Moonshine"
  WriteRegStr HKCR "moonshine" "URL Protocol" ""
  WriteRegStr HKCR "moonshine\DefaultIcon" "" "$INSTDIR\Moonshine.exe,0"
  WriteRegStr HKCR "moonshine\shell\open\command" "" '"$INSTDIR\Moonshine.exe" "%1"'
SectionEnd

Section "-Host" SEC_HOST
  ; The host engine (same steps as Apollo's own installer, minus its PATH entry and web shortcut).
  ; Its config folder is never overwritten: that is the user's settings, apps and paired devices.
  DetailPrint "Installing the host..."
  SetOutPath "${HOST_DIR}"
  File /r /x config "${STAGE}\apollo\*.*"
  nsExec::ExecToLog /TIMEOUT=180000 'icacls "${HOST_DIR}" /reset'
  DetailPrint "Installing the virtual display driver..."
  nsExec::ExecToLog /TIMEOUT=180000 '"${HOST_DIR}\drivers\sudovda\install.bat"'
  ; Clear rules from earlier installs first, or every install would add another pair.
  nsExec::ExecToLog /TIMEOUT=180000 '"${HOST_DIR}\scripts\delete-firewall-rule.bat"'
  nsExec::ExecToLog /TIMEOUT=180000 '"${HOST_DIR}\scripts\add-firewall-rule.bat"'
  DetailPrint "Installing the virtual gamepad driver..."
  nsExec::ExecToLog /TIMEOUT=180000 'powershell.exe -ExecutionPolicy Bypass -File "${HOST_DIR}\scripts\install-gamepad.ps1"'
  DetailPrint "Starting the host..."
  nsExec::ExecToLog /TIMEOUT=180000 '"${HOST_DIR}\scripts\install-service.bat"'
  nsExec::ExecToLog /TIMEOUT=180000 '"${HOST_DIR}\scripts\autostart-service.bat"'
  SetOutPath "$INSTDIR"

  ; Tailscale powers the friend invites; offer it if it's missing.
  IfFileExists "$PROGRAMFILES64\Tailscale\tailscale.exe" tailscale_ok
    MessageBox MB_YESNO|MB_ICONQUESTION "Moonshine uses Tailscale to connect with friends. Open the Tailscale download page?" /SD IDNO IDNO tailscale_ok
    ExecShell "open" "https://tailscale.com/download/windows"
  tailscale_ok:
SectionEnd
!endif

; Defined after the sections so it can refer to their indexes.
Function .onInit
  ; Both unticked on a fresh install. A silent run is an in-app update: keep the shortcuts as they are
  ; (kept if they exist, and not re-added if deleted).
  StrCpy $DesktopShortcut 0
  StrCpy $StartShortcut 0
  ${If} ${Silent}
    ${If} ${FileExists} "$DESKTOP\Moonshine.lnk"
      StrCpy $DesktopShortcut 1
    ${EndIf}
    ${If} ${FileExists} "$SMPROGRAMS\Moonshine.lnk"
      StrCpy $StartShortcut 1
    ${EndIf}
  ${EndIf}
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Moonshine needs 64-bit Windows."
    Abort
  ${EndIf}
  SetRegView 64

  StrCpy $HostPlan "fresh"
  ${If} ${FileExists} "${APOLLO_DIR}\sunshine.exe"
    StrCpy $HostPlan "migrate"
  ${ElseIf} ${FileExists} "$INSTDIR\host\sunshine.exe"
    StrCpy $HostPlan "update"
  ${EndIf}

  ${If} $HostPlan == "migrate"
    StrCpy $PlanText "This installs Moonshine and moves your Apollo settings, apps and paired devices into it. The separate Apollo is then removed, and nothing has to pair again."
  ${ElseIf} $HostPlan == "update"
    StrCpy $PlanText "This updates Moonshine. Your settings, apps and paired devices are kept."
  ${Else}
    StrCpy $PlanText "This installs Moonshine, including the host that lets your devices and friends stream from this PC."
  ${EndIf}
FunctionEnd

; ---- Uninstall ------------------------------------------------------------------------

Section "Uninstall"
  SetRegView 64
  nsExec::ExecToLog /TIMEOUT=180000 'taskkill /im Moonshine.exe /f'
  nsExec::ExecToLog /TIMEOUT=180000 'netsh advfirewall firewall delete rule name="${INVITE_RULE}"'
  nsExec::ExecToLog /TIMEOUT=180000 'netsh advfirewall firewall delete rule name="${TUNNEL_RULE}"'

  ; The host: its service, firewall rule and (with the folder below) its settings and paired devices.
  nsExec::ExecToLog /TIMEOUT=180000 '"$INSTDIR\host\scripts\delete-firewall-rule.bat"'
  nsExec::ExecToLog /TIMEOUT=180000 '"$INSTDIR\host\scripts\uninstall-service.bat"'
  nsExec::ExecToLog /TIMEOUT=180000 '"$INSTDIR\host\sunshine.exe" --restore-nvprefs-undo'
  MessageBox MB_YESNO|MB_ICONQUESTION "Also remove the virtual display and virtual gamepad drivers?$\r$\n$\r$\nChoose No if another streaming host on this PC (Apollo or Sunshine) uses them." /SD IDNO IDNO keep_drivers
    nsExec::ExecToLog /TIMEOUT=180000 'powershell.exe -ExecutionPolicy Bypass -File "$INSTDIR\host\scripts\uninstall-gamepad.ps1"'
    nsExec::ExecToLog /TIMEOUT=180000 '"$INSTDIR\host\drivers\sudovda\uninstall.bat"'
  keep_drivers:

  Delete "$SMPROGRAMS\Moonshine.lnk"
  Delete "$DESKTOP\Moonshine.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKLM "${UNINSTALL_KEY}"
  DeleteRegKey HKCR "moonshine"
SectionEnd
