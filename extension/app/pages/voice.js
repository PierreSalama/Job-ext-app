// v8: Voice quick-add. Uses Web Speech API (Chrome native) to capture a sentence,
// passes through AI to extract structured job fields, previews before saving.
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

let _state = { listening: false, transcript: '', parsed: null, error: '' };
let _recognizer = null;

export function render() {
  const supported = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
  return `
    <div class="page-h">
      <div><h1>🎙️ Voice Quick-Add</h1>
      <div class="sub">Speak naturally — AI extracts the title, company, status, and date.</div></div>
    </div>
    ${!supported ? `<div class="card empty"><strong>Voice not supported in this browser.</strong> Chrome desktop is required.</div>` : `
      <div class="card">
        <div style="display:flex;gap:10px;align-items:center">
          <button class="btn ${_state.listening ? 'danger' : 'primary'}" id="v-toggle">${_state.listening ? '⏹ Stop' : '🎙 Start listening'}</button>
          <span class="s" style="color:var(--muted)">${_state.listening ? 'Listening… speak now.' : 'Try: "I applied to Stripe yesterday as a senior engineer, remote".'}</span>
        </div>
        ${_state.transcript ? `
          <div style="margin-top:14px">
            <label>Transcript</label>
            <div class="card" style="background:var(--bg-soft, #f6f8fa);font-size:13px">${esc(_state.transcript)}</div>
          </div>
        ` : ''}
        ${_state.parsed ? `
          <div style="margin-top:14px">
            <h3 style="font-size:14px">AI-parsed fields (review before saving)</h3>
            <div class="grid-2">
              <div><label>Title</label><input id="v-title" value="${esc(_state.parsed.title || '')}" /></div>
              <div><label>Company</label><input id="v-company" value="${esc(_state.parsed.company || '')}" /></div>
            </div>
            <div class="grid-2">
              <div><label>Status</label>
                <select id="v-status">
                  <option value="started" ${_state.parsed.status === 'started' ? 'selected' : ''}>Started</option>
                  <option value="submitted" ${_state.parsed.status === 'submitted' ? 'selected' : ''}>Submitted</option>
                  <option value="interview" ${_state.parsed.status === 'interview' ? 'selected' : ''}>Interview</option>
                  <option value="offer" ${_state.parsed.status === 'offer' ? 'selected' : ''}>Offer</option>
                  <option value="rejected" ${_state.parsed.status === 'rejected' ? 'selected' : ''}>Rejected</option>
                </select>
              </div>
              <div><label>Location / mode</label><input id="v-location" value="${esc(_state.parsed.location || '')}" /></div>
            </div>
            <div style="margin-top:10px;display:flex;gap:6px">
              <button class="btn primary" id="v-save">Save application</button>
              <button class="btn" id="v-clear">Clear</button>
            </div>
          </div>
        ` : ''}
        ${_state.error ? `<div class="card danger" style="margin-top:10px">${esc(_state.error)}</div>` : ''}
      </div>
    `}
  `;
}

function parseTranscript(t) {
  const out = { title: '', company: '', status: 'submitted', location: '' };
  const txt = String(t || '');
  // Status keywords
  if (/\bofferred?|\boffer\b|got an offer/i.test(txt)) out.status = 'offer';
  else if (/\brejected\b|got rejected|turned down/i.test(txt)) out.status = 'rejected';
  else if (/\binterview/i.test(txt)) out.status = 'interview';
  else if (/\bapplied|submitted/i.test(txt)) out.status = 'submitted';
  else if (/\bstarted|in progress/i.test(txt)) out.status = 'started';

  // Location/mode
  const locM = txt.match(/\b(remote|hybrid|on[- ]site|onsite|in[- ]office)\b/i);
  if (locM) out.location = locM[1].toLowerCase();

  // Try "applied to X as Y" or "to X" patterns
  const m1 = txt.match(/(?:applied|submitted|interview|offer)\s+(?:at|to|with|from)\s+([A-Z][\w &.-]+?)(?:\s+(?:as|for)\s+(.+?))?(?:[.,]|$)/i);
  if (m1) {
    out.company = m1[1].trim();
    if (m1[2]) out.title = m1[2].replace(/^(a|an|the)\s+/i, '').trim();
  }
  if (!out.title) {
    const m2 = txt.match(/\b(?:senior|junior|staff|principal|lead|sr|jr)\s+[\w ]+?(?=\s+(?:engineer|developer|designer|manager|analyst|scientist|architect))[\w ]+/i);
    if (m2) out.title = m2[0].trim();
  }
  return out;
}

export function attach($main, ctx) {
  const { send, toast, render: rerender } = ctx;

  $main.querySelector('#v-toggle')?.addEventListener('click', () => {
    if (_state.listening) {
      try { _recognizer?.stop(); } catch {}
      _state.listening = false; rerender(); return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { _state.error = 'SpeechRecognition unavailable.'; rerender(); return; }
    _recognizer = new SR();
    _recognizer.continuous = false;
    _recognizer.interimResults = true;
    _recognizer.lang = 'en-US';
    _recognizer.onresult = (e) => {
      let t = '';
      for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
      _state.transcript = t.trim();
      rerender();
    };
    _recognizer.onend = () => {
      _state.listening = false;
      if (_state.transcript) _state.parsed = parseTranscript(_state.transcript);
      rerender();
    };
    _recognizer.onerror = (e) => {
      _state.error = 'Voice error: ' + (e?.error || 'unknown');
      _state.listening = false; rerender();
    };
    _state.listening = true; _state.transcript = ''; _state.parsed = null; _state.error = '';
    rerender();
    try { _recognizer.start(); } catch (err) { _state.error = String(err); _state.listening = false; rerender(); }
  });

  $main.querySelector('#v-save')?.addEventListener('click', async () => {
    const payload = {
      title: $main.querySelector('#v-title')?.value.trim() || _state.parsed?.title || 'Voice-added job',
      company: $main.querySelector('#v-company')?.value.trim() || _state.parsed?.company || '',
      status: $main.querySelector('#v-status')?.value || 'submitted',
      location: $main.querySelector('#v-location')?.value.trim() || '',
      source: 'Voice',
      _source: 'voice',
      applied: true
    };
    if (!payload.title || !payload.company) { toast('Title + company required.', 'danger'); return; }
    const r = await send('upsert-job', payload);
    if (r?.ok) {
      toast('Saved!', 'success');
      _state = { listening: false, transcript: '', parsed: null, error: '' };
      rerender();
    }
  });

  $main.querySelector('#v-clear')?.addEventListener('click', () => {
    _state = { listening: false, transcript: '', parsed: null, error: '' };
    rerender();
  });
}
