import { getNewsletter, saveProgress, markProgressSynced } from '../db.js';
import { apiFetch } from '../api.js';
import { App } from '@capacitor/app';

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function injectStyle(html) {
  const dark = document.body.classList.contains('dark');
  // Always inject light colours — dark mode is handled by CSS invert() on the iframe element.
  return `<style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           font-size: 15px; line-height: 1.6; color: #1a1a1a;
           background: #ffffff;
           padding: 10px; max-width: 700px; margin: 0 auto; }
    img, table { max-width: 100% !important; }
    img  { height: auto; ${dark ? 'filter: invert(1) hue-rotate(180deg);' : ''} }
    td, th { word-break: break-word; }
    a    { color: #2563eb; }
    body { overflow-x: hidden; }
  </style>${html}`;
}

export async function renderReader(app, id) {
  const n = await getNewsletter(parseInt(id));
  if (!n) {
    app.innerHTML = '<p class="empty" style="padding:32px">Newsletter not found.</p>';
    return;
  }

  document.title = n.subject;
  app.innerHTML = `
    <header>
      <div class="container reader-header">
        <button class="btn-ghost" id="back-btn">← Back</button>
        <h1 id="header-title">${esc(n.subject)}</h1>
        <button class="mark-read-btn${n.is_read ? ' is-read' : ''}" id="mark-read-btn">
          ${n.is_read ? 'Read' : 'Mark read'}
        </button>
      </div>
    </header>
    <main class="container" id="reader-root">
      <div class="reader-meta">
        <div class="reader-subject">${esc(n.subject)}</div>
        <div class="reader-sender">${esc(n.sender)}</div>
        <div class="reader-date">${new Date(n.received_at).toLocaleString()}</div>
      </div>
      <div class="reader-frame-wrap" id="frame-wrap"></div>
    </main>
  `;

  let isRead = !!n.is_read;
  let scrollPos = n.scroll_position || 0;
  const markReadBtn = document.getElementById('mark-read-btn');
  const frameWrap = document.getElementById('frame-wrap');
  const scrollCtrl = new AbortController();

  function updateBtn() {
    markReadBtn.textContent = isRead ? 'Read' : 'Mark read';
    markReadBtn.className = `mark-read-btn${isRead ? ' is-read' : ''}`;
  }

  async function persist() {
    await saveProgress(n.id, scrollPos, isRead); // marks dirty=1
    updateBtn();
    // Try to push to server immediately; dirty flag ensures retry on next sync if offline
    try {
      await apiFetch(`/api/newsletters/${n.server_id}/progress`, {
        method: 'POST',
        body: JSON.stringify({ scroll_position: Math.floor(scrollPos), is_read: isRead }),
      });
      await markProgressSynced(n.server_id);
    } catch {
      // Offline or error — will retry via flushPendingProgress on next sync
    }
  }

  async function goBack() {
    scrollCtrl.abort();
    await persist();
    window.location.hash = '#/';
  }

  document.getElementById('back-btn').addEventListener('click', async () => {
    backHandle.remove();
    await goBack();
  });

  const backHandle = await App.addListener('backButton', async () => {
    backHandle.remove();
    await goBack();
  });

  markReadBtn.addEventListener('click', async () => {
    isRead = !isRead;
    await persist();
  });

  if (n.body_html) {
    const iframe = document.createElement('iframe');
    iframe.className = 'reader-frame';
    iframe.sandbox = 'allow-same-origin';
    iframe.scrolling = 'no';
    frameWrap.appendChild(iframe);
    iframe.contentDocument.open();
    iframe.contentDocument.write(injectStyle(n.body_html));
    iframe.contentDocument.close();

    // Intercept link clicks and open in system browser (Capacitor convention)
    iframe.contentDocument.querySelectorAll('a[href]').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        const url = a.href;
        if (url && url.startsWith('http')) window.open(url, '_system');
      });
    });

    function resize() {
      iframe.style.height = iframe.contentDocument.documentElement.scrollHeight + 'px';
    }
    iframe.addEventListener('load', resize);
    setTimeout(() => {
      resize();
      if (scrollPos > 0) window.scrollTo(0, scrollPos);
      // Short newsletters that fit without scrolling: mark as read immediately
      if (!isRead && window.scrollY + window.innerHeight >= document.body.scrollHeight - 50) {
        isRead = true;
        persist();
      }
    }, 300);

    window.addEventListener('scroll', debounce(() => {
      scrollPos = Math.floor(window.scrollY);
      const atBottom = window.scrollY + window.innerHeight >= document.body.scrollHeight - 50;
      if (atBottom) isRead = true;
      persist();
    }, 500), { signal: scrollCtrl.signal });
  } else if (n.body_text) {
    const pre = document.createElement('pre');
    pre.className = 'reader-text';
    pre.textContent = n.body_text;
    frameWrap.appendChild(pre);
  } else {
    frameWrap.innerHTML = '<p class="empty" style="padding:24px">No content cached yet. Open when online to download.</p>';
  }
}
