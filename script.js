function showSection(key) {
        document.querySelectorAll('.section').forEach(s => {
            s.style.display = (s.id === 'section-' + key) ? 'block' : 'none';
        });
    }
async function sendMessage() {
  const input = document.getElementById("input");
  const chat = document.getElementById("chat");

  const message = input.value;
  if (!message) return;

  chat.innerHTML += `<div class="user">You: ${message}</div>`;
  input.value = "";

  const response = await fetch("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message })
  });

  const data = await response.json();
  chat.innerHTML += `<div class="bot">Doctor AI: ${data.reply}</div>`;
}