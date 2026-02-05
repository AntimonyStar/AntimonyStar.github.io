function showSection(key) {
        document.querySelectorAll('.section').forEach(s => {
            s.style.display = (s.id === 'section-' + key) ? 'block' : 'none';
        });
    }
function submitPrivate() {
    const textEl = document.getElementById('privateText');
    const text = (textEl && textEl.value || '').trim();
    if (!text) { alert('Please enter a message.'); return; }
    const entry = document.createElement('div');
    entry.textContent = 'Private: ' + text;
    entry.style.marginBottom = '10px';
    document.getElementById('messages').prepend(entry);
    textEl.value = '';
}