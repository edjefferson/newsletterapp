import './style.css';
import { initDB } from './db.js';
import { getToken } from './api.js';
import { renderLogin } from './pages/login.js';
import { renderList } from './pages/list.js';
import { renderReader } from './pages/reader.js';
import { App } from '@capacitor/app';

const app = document.getElementById('app');

let activeBackHandle = null;

async function route() {
  // Remove back handler registered by the previous page
  if (activeBackHandle) {
    activeBackHandle.remove();
    activeBackHandle = null;
  }

  const hash = window.location.hash || '#/';
  const token = await getToken();

  if (!token && hash !== '#/login') {
    window.location.hash = '#/login';
    return;
  }

  // Remove any stale scroll listeners from previous page
  window.onscroll = null;

  // Hide instantly while we swap content
  app.style.transition = 'none';
  app.style.opacity = '0';

  if (hash === '#/login') {
    renderLogin(app);
  } else if (hash === '#/') {
    renderList(app).catch(console.error);
    // Set up back button without blocking the fade-in
    App.addListener('backButton', () => App.exitApp())
      .then(h => { activeBackHandle = h; })
      .catch(console.error);
  } else if (hash.startsWith('#/reader/')) {
    const id = hash.split('/').pop();
    // Await so content + scroll position are set before we fade in
    await renderReader(app, id).catch(console.error);
  }

  // Fade in after content is ready
  requestAnimationFrame(() => {
    app.style.transition = 'opacity 0.18s ease';
    requestAnimationFrame(() => {
      app.style.opacity = '1';
    });
  });
}

async function main() {
  await initDB();
  window.addEventListener('hashchange', () => route());
  await route();
}

main().catch(console.error);
