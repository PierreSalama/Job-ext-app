# Bundled installers

This folder ships *inside* the Chrome extension. Whatever artifact you find
here was built ahead of time and is what the extension's **Install desktop
app** page hands to you when you click "Run bundled installer".

## What you might see

| File | OS | What it does |
| --- | --- | --- |
| `JAT-v9-setup.exe` | Windows | One-click setup. Installs the desktop app to `%LOCALAPPDATA%\Programs\JobApplicationTrackerV7`, adds Start Menu / Desktop shortcuts, registers the `jat9://` URL handler so the extension can launch the app, and (optionally) sets `OLLAMA_ORIGINS=chrome-extension://*`. |
| `JAT-v9.pkg` | macOS | Standard Apple installer package. Drops the app under `/Applications`. |
| `JAT-v9.AppImage` | Linux | Single-file portable binary. `chmod +x` then run. No system install required. |
| `JAT-v9.deb` | Debian / Ubuntu | Install with `sudo dpkg -i JAT-v9.deb` (or double-click in your file manager). |
| `install-jat-app-*.{ps1,sh}` | All | Old fallback scripts that build the app from source. Use only if the prebuilt installer above is missing. |
| `install-ollama-*.{ps1,sh}` | All | Optional helpers to install [Ollama](https://ollama.com), the local LLM server the extension talks to. |

## How to run them — newbie version

### Windows
1. In the extension popup, open **Install desktop app**.
2. Click **Run bundled installer**. Chrome will save `JAT-v9-setup.exe` to
   your Downloads folder.
3. Open Downloads, double-click `JAT-v9-setup.exe`.
4. Click through. When it finishes, the app opens automatically.
5. Go back to the extension's install page and click **Pair now**. Done.

If Windows SmartScreen complains ("unrecognized app"), click **More info →
Run anyway**. The installer is unsigned because this is a personal project.

### macOS
1. Click **Run bundled installer** on the install page → it downloads `JAT-v9.pkg`.
2. Double-click it from Downloads. Walk through the standard Apple installer.
3. Launch **Job Application Tracker** from Applications, then **Pair now**.

If macOS blocks it ("can't be opened because Apple cannot check it for
malicious software"), right-click → **Open** instead of double-click.

### Linux

**AppImage (easiest):**
```bash
cd ~/Downloads
chmod +x JAT-v9.AppImage
./JAT-v9.AppImage
```

**.deb (Ubuntu / Debian):**
```bash
sudo dpkg -i JAT-v9.deb
sudo apt-get install -f   # if anything is missing
```

Then go back to the extension's install page and click **Pair now**.

## Why these aren't always present

The installers are **built on demand** by the maintainer. If you cloned the
repo and this folder only has the `.ps1` / `.sh` source-build scripts, that
just means nobody built the binaries for your machine yet. Run one of:

- Windows: `v8\app\build\build-windows-installer.ps1`
- macOS: `v9/app/build/build-mac.sh`
- Linux: `v9/app/build/build-linux.sh`

…and the binaries will land here automatically.

## Why bundle them inside the extension?

Chrome extensions can't install native software directly (security model).
But they *can* serve files from their own folder via `chrome.runtime.getURL`
and trigger a download with `chrome.downloads.download`. So the trick is:
ship the installer as an extension resource, then download it on click. The
user only has to double-click the resulting file.

It's the closest thing to one-click native install a Chrome extension can do.
