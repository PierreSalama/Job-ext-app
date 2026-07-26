JAT SERVER  -  this laptop as an always-on auto-apply node
==========================================================

WHAT THIS IS
  Turns this laptop into a machine that runs Pierre's job auto-apply 24/7, so his
  main computer is free. Pierre controls it remotely - he does not need to sit at
  this laptop.

HOW TO INSTALL (one time)
  1. Plug in the USB.
  2. Open JAT-Dad-Setup\server (this folder).
  3. Double-click  INSTALL-SERVER.bat
  4. Click "Yes" on the admin prompt. Wait for DONE.
  Keep the laptop plugged in. It is fine to close the lid - it stays running.

WHAT IT INSTALLS (all visible, all removable)
  * The JAT app
  * Firefox + the JAT extension (this is what submits applications)
  * Tailscale - Pierre's private, encrypted remote-access network (his own device)
  * A "JAT Watchdog" background task that keeps the app + Firefox running
  * Power settings so the laptop never sleeps while plugged in
  Everything lives in C:\ProgramData\JAT-Remote and is named clearly.

AFTER INSTALL
  Pierre finishes the setup remotely - loads his profile + resume and turns
  auto-apply on. Leave the laptop plugged in and Firefox open (the watchdog keeps
  it open on its own).

TO REMOVE IT
  Run  C:\ProgramData\JAT-Remote\Uninstall-Remote.ps1  (right-click, Run with
  PowerShell).
