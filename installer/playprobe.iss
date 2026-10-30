; Inno Setup script for the PlayProbe installer. Built by `npm run build:exe` (passes /DSrc and /DVersion).
; Installs per user (no administrator rights needed) into %LOCALAPPDATA%\Programs\PlayProbe.

#ifndef Version
  #define Version "1.0.0"
#endif
#ifndef Src
  #error Pass /DSrc=<folder containing PlayProbe.exe and tools>
#endif

[Setup]
AppId={{B6F1C2A4-7D3E-4C59-9A8B-5E2D1F0A9C71}
AppName=PlayProbe
AppVersion={#Version}
AppPublisher=PlayProbe
DefaultDirName={autopf}\PlayProbe
DefaultGroupName=PlayProbe
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputBaseFilename=PlayProbe-Setup-{#Version}
Compression=lzma2/fast
SolidCompression=no
WizardStyle=modern
UninstallDisplayIcon={app}\PlayProbe.exe
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "{#Src}\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Dirs]
Name: "{app}\logs"
Name: "{app}\.playprobe"

[Icons]
Name: "{autoprograms}\PlayProbe"; Filename: "{app}\PlayProbe.exe"
Name: "{autoprograms}\PlayProbe logs"; Filename: "{app}\logs"
Name: "{autoprograms}\Stop PlayProbe"; Filename: "{app}\PlayProbe.exe"; Parameters: "--quit"
Name: "{autodesktop}\PlayProbe"; Filename: "{app}\PlayProbe.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\PlayProbe.exe"; Description: "Start PlayProbe now"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{app}\PlayProbe.exe"; Parameters: "--quit"; Flags: runhidden; RunOnceId: "QuitPlayProbe"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\.playprobe"
Type: files; Name: "{app}\PlayProbe-error.txt"

[Code]
// Stop a running copy before files are replaced or removed.
procedure QuitRunningCopy();
var
  ResultCode: Integer;
begin
  if FileExists(ExpandConstant('{app}\PlayProbe.exe')) then
  begin
    Exec(ExpandConstant('{app}\PlayProbe.exe'), '--quit', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(1500);
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  QuitRunningCopy();
  Result := '';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then Sleep(1500);
end;
