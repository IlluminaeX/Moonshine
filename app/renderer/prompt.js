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
  if (s.pin) {
    $('#pin').required = true;
    $('#device-name').value = s.name || '';
    $('#pin').focus();
  }
});

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
