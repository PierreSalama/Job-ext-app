; Inno Setup script for Job Application Tracker v9 desktop companion.
; Compile with: iscc.exe installer.iss
;
; Expects electron-builder to have produced an unpacked Win build at:
;   ../dist/win-unpacked/
; ...which is the default electron-builder output for `--win` targets.

#define MyAppName "Job Application Tracker v9"
#define MyAppShortName "JAT v8"
#define MyAppVersion "7.0.0"
#define MyAppPublisher "Pierre"
#define MyAppURL "https://github.com/Pierre/job-application-tracker"
#define MyAppExeName "Job Application Tracker.exe"
#define MyAppId "{{B7A4F2E0-9C5D-4E2A-A7B1-1F3E7A2C9D4B}"
#define SourceUnpacked "..\dist\win-unpacked"
#define OutputDir "..\..\extension\setup"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={userpf}\JobApplicationTrackerV7
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
LicenseFile=..\..\LICENSE.txt
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir={#OutputDir}
OutputBaseFilename=JAT-v9-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "autostart"; Description: "Launch Job Application Tracker v9 automatically when Windows starts"; GroupDescription: "Startup:"; Flags: unchecked
Name: "ollamaorigins"; Description: "Set OLLAMA_ORIGINS=chrome-extension://* (lets the extension talk to Ollama)"; GroupDescription: "AI integration:"

[Files]
; Copy the entire electron-builder unpacked tree.
Source: "{#SourceUnpacked}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#MyAppShortName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Registry]
; Register the jat9:// URL handler so the extension can launch the app.
Root: HKCU; Subkey: "Software\Classes\jat9"; ValueType: string; ValueName: ""; ValueData: "URL:Job Application Tracker v9 Protocol"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\jat9"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\jat9\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#MyAppExeName},0"
Root: HKCU; Subkey: "Software\Classes\jat9\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" ""%1"""

; Optional autostart (only created when user picks the task).
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "JobApplicationTrackerV7"; ValueData: """{app}\{#MyAppExeName}"" --hidden"; Tasks: autostart; Flags: uninsdeletevalue

; OLLAMA_ORIGINS env var so the extension's chrome-extension:// origin is allowed.
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "OLLAMA_ORIGINS"; ValueData: "chrome-extension://*"; Tasks: ollamaorigins; Flags: preservestringtype

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName} now"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Wipe install dir leftovers (logs, caches we wrote there). User-data lives in
; %APPDATA%\Job Application Tracker — left alone so reinstall keeps history.
Type: filesandordirs; Name: "{app}"

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    Log('JAT v8 install complete. Protocol jat9:// registered. Autostart=' + IntToStr(Ord(WizardIsTaskSelected('autostart'))));
  end;
end;
