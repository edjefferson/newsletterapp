import { login } from '../api.js';

export function renderLogin(app) {
  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <h1>Newsletters</h1>
        <form id="login-form">
          <div class="login-field">
            <label for="password">Password</label>
            <input type="password" id="password" autocomplete="current-password" autofocus />
          </div>
          <div class="login-error" id="login-error"></div>
          <button type="submit" class="btn-primary">Sign in</button>
        </form>
      </div>
    </div>
  `;

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('login-error');
    errorEl.textContent = '';
    const password = document.getElementById('password').value;
    try {
      await login(password);
      window.location.hash = '#/';
    } catch {
      errorEl.textContent = 'Wrong password.';
    }
  });
}
