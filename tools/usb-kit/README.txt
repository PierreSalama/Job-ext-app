========================================================
  JAT setup for Dad  -  do this on Dad's laptop
========================================================

You only run ONE thing. It installs the app, sets it up, installs the
Firefox extension, connects everything, and sends the results back to you.

STEPS
-----
1. Plug in this USB.

2. Copy the WHOLE folder from the USB onto Dad's Desktop.
   (Right-click the folder -> Copy, then right-click the Desktop -> Paste.)

3. Unplug the USB (optional - the copy on the Desktop is what you run).

4. Open the copied folder on the Desktop.
   Right-click  Setup-JAT.ps1  ->  "Run with PowerShell".
   Click YES on the admin prompt.

5. Watch it go. It prints green "ok" lines as it:
      - installs / updates the app
      - turns off AI, pins updates, tunes auto-apply for telecom work
      - turns on remote monitoring (so you can watch from your PC)
      - installs the Firefox extension automatically
      - checks everything
      - sends a report back to your PC
   It ends with "DONE." and prints links you can open from your own PC.

6. Press Enter to close.

THAT'S IT. To start applying: open the JAT app -> Auto-Apply -> Start.


WATCHING FROM YOUR PC
---------------------
Near the end the script prints link(s) like:
    http://192.168.2.xx:7744/app/?token=....#/auto-apply
Open one of those in a browser on YOUR PC (same home network) to see
Dad's JAT live - what it's applying to, every application, activity.
The full setup report is also sent to your PC automatically (if your
own JAT is open on the same network) and saved on Dad's Desktop as
JAT-setup-report.txt.


IF SOMETHING LOOKS OFF
----------------------
- "Firefox not found": install Firefox on the laptop, then run Setup-JAT.ps1 again.
- The Indeed white-flash problem has its own sheet: INDEED-DIAGNOSIS.md.
- Nothing else to run - Setup-JAT.ps1 is the only script.
