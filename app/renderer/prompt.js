const $ = (sel) => document.querySelector(sel);
let spec = null;

window.moonshinePrompt.onShow((s) => {
  spec = s;
  $('#prompt-title').textContent = s.title;
  $('#prompt-details').replaceChildren(...s.details.filter(Boolean).map((line) => {
    const p = document.createElement('p');
    p.textContent = line;
    return p;
  }));
  $('#prompt-accept').textContent = s.accept;
  $('#prompt-decline').textContent = s.decline;
  $('#prompt-decline').className = s.danger ? 'danger' : 'secondary';
  $('#prompt-check-row').classList.toggle('hidden', !s.checkbox);
  $('#prompt-check-label').textContent = s.checkbox || '';
  $('#prompt-pin').classList.toggle('hidden', !s.pin);
  const bar = $('#prompt-timer');
  bar.classList.toggle('hidden', !s.timeoutMs);
  if (s.timeoutMs) {
    bar.style.animationDuration = `${s.timeoutMs}ms`;
    bar.classList.add('running');
  }
  if (s.sound === 'join') playChime();
  if (s.pin) {
    $('#pin').required = true;
    $('#device-name').value = s.name || '';
    $('#pin').focus();
  }
});

/** A short, friendly two-note chime (made here, so there's no sound file to ship). */
function playChime() {
  try {
    const ctx = new AudioContext();
    const notes = [[784, 0], [1175, 0.12]]; // G5 then D6
    for (const [freq, at] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = ctx.currentTime + at;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.35, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.5);
    }
    setTimeout(() => ctx.close(), 1000);
  } catch {
    // no audio device: the popup still shows
  }
}

// Only digits in the PIN box.
$('#pin').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, ''); });

$('#prompt-form').addEventListener('submit', (e) => {
  e.preventDefault();
  window.moonshinePrompt.respond({
    ok: true,
    checked: $('#prompt-check').checked,
    pin: spec.pin ? $('#pin').value : undefined,
    name: spec.pin ? $('#device-name').value.trim() : undefined,
  });
});

$('#prompt-decline').addEventListener('click', () => window.moonshinePrompt.respond({ ok: false, declined: true }));
