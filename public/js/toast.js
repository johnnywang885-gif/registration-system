(function () {
  let container = null;

  function ensureContainer() {
    if (container && container.isConnected) return container;
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
    return container;
  }

  function toast(msg, type = 'success') {
    const box = document.createElement('div');
    box.className = 'toast toast-' + type;
    box.textContent = msg;
    ensureContainer().appendChild(box);
    requestAnimationFrame(() => box.classList.add('show'));
    setTimeout(() => {
      box.classList.remove('show');
      setTimeout(() => box.remove(), 300);
    }, 3000);
  }

  window.toast = toast;
})();
