# Troubleshooting

## AI

**"Cannot reach Ollama at http://localhost:11434"**
- Make sure the Ollama app is running. On Windows it lives in the system tray.
- Open <http://localhost:11434> in a browser — should say "Ollama is running."

**"Ollama returned 403"**
- The extension auto-rewrites the `Origin` header to `http://localhost:11434` via declarativeNetRequest.
- If you still see 403, set the env var manually: `setx OLLAMA_ORIGINS "chrome-extension://*"` (Windows) or `launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"` (macOS), then restart Ollama.
- Or run the bundled setup script: `extension/setup/install-ollama-windows.ps1`.

**"AI timeout (180s)"**
- The chosen model may not be pulled. Run `ollama pull gemma4:e4b` (or whichever model you set in Settings).
- Check the model size matches your hardware. `gemma4:e4b` needs ~3 GB free RAM; on slower machines try `gemma3:1b`.

**Cover Letter / Summary button hangs forever**
- v5 had this bug from MV3 service-worker termination. v6 uses a port-based AI channel that keeps the SW alive. If you still see hangs, reload the extension at `chrome://extensions/`.

## Sync between extension + desktop app

**"Desktop app offline" pill in extension**
- Make sure the app is running: `cd v6/app && npm start`.
- The app listens on `http://localhost:7733`. If port 7733 is taken, set `JAT_SYNC_PORT=8888` (or any free port) before starting and update Settings → Sync interval URL in the extension.

**Changes not syncing**
- Open the **Audit log** page in the extension. Every change should appear within 1 second. If it doesn't, check the desktop app's terminal for errors.
- Last-write-wins is by `updatedAt` timestamp — clock skew between machines can cause apparent staleness.

## Extension capture

**Job site not detected**
- Open the extension's Logs page (sidebar → Activity logs) and filter for "Capture". You should see "Adapter: LinkedIn" or similar when you load the site.
- If no log appears, the content script didn't load. Reload the extension and refresh the page.

**Apply dialog doesn't trigger autofill prompt**
- Autofill is offered when ≥2 fields can be auto-filled. If you have a fresh profile, fill out the application once manually — every answer is captured into the qa store, and the next time autofill will offer them.
- Check Settings → AI provider; if no AI is configured, no harvest takes place but autofill from saved answers still works.

## Documents

**PDF Open / Download "Failed to load PDF document"**
- Fixed in v6 by always inferring the MIME from filename extension. If you see this error on a v6 install, file an issue with the document's filename + size.

## Reset

**Start clean**
- Extension: `chrome://extensions/` → click extension's "Details" → "Extension options" or just **Remove** and re-load unpacked.
- Desktop: delete `~/.config/jat6-app/jat6.db` (or `%APPDATA%\jat6-app\jat6.db` on Windows).
