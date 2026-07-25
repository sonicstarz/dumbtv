; Inno Setup script — builds dumbTV-Setup.exe from an assembled payload/ folder
; (the release CI puts the app + a bundled node.exe + mpv.exe + launcher there).
; Build:  iscc windows\dumbtv.iss

#define AppName "dumbTV"
#ifndef AppVersion
  #define AppVersion "1.0"
#endif

[Setup]
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=dumbTV
DefaultDirName={autopf}\dumbTV
DefaultGroupName=dumbTV
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=dumbTV-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible

[Files]
Source: "payload\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\dumbTV"; Filename: "{app}\dumbTV.cmd"; WorkingDir: "{app}"
Name: "{autodesktop}\dumbTV"; Filename: "{app}\dumbTV.cmd"; WorkingDir: "{app}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[Run]
Filename: "{app}\dumbTV.cmd"; Description: "Launch dumbTV now"; Flags: postinstall nowait skipifsilent
