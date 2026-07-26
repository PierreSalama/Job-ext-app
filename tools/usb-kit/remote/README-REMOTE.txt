JAT REMOTE ACCESS  -  what this is and how to use it
=====================================================

WHY
  So Pierre can fix the Job Application Tracker for you without driving over or
  walking you through it on the phone. If the app or the Firefox extension ever
  stops, he can quietly restart it for you.

HOW TO INSTALL (one time, ~2 minutes)
  1. Plug in the USB.
  2. Open the JAT-Dad-Setup\Remote folder.
  3. Double-click  INSTALL-REMOTE.bat
  4. Click "Yes" on the admin prompt. Wait for it to say DONE. That's it.
  You can unplug the USB afterward. It keeps working after restarts.

WHAT IT INSTALLS (nothing hidden)
  * Tailscale - a private, encrypted link to Pierre's own devices ONLY. Nobody
    else can see or reach this machine through it. It runs quietly in the
    background and reconnects on its own after a restart.
  * A small "JAT Watchdog" background task that reopens the app if it closes.
  Everything lives in the folder  C:\ProgramData\JAT-Remote  and the task is
  named "JAT Watchdog" in Task Scheduler - all visible, all removable.

WHAT PIERRE CAN AND CANNOT DO
  He can reach the JAT app and restart the app or the extension. That is the
  whole point. He is not watching your screen and this is not for anything else.

TO REMOVE IT COMPLETELY, ANY TIME
  Run  C:\ProgramData\JAT-Remote\Uninstall-Remote.ps1  (right-click, Run with
  PowerShell). It disconnects Tailscale, deletes the watchdog, and cleans up.
  The JAT app itself is left alone.

QUESTIONS -> just ask Pierre.
