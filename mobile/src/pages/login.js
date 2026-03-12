import { login } from '../api.js';

const EYE_ON  = `<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>`;
const EYE_OFF = `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-10-8-10-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>`;

export function renderLogin(app) {
  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <h1>Newsletters</h1>
        <form id="login-form">
          <div class="login-field">
            <label for="password">Password</label>
            <div class="password-wrap">
              <input type="password" id="password" autocomplete="current-password" />
              <button type="button" id="pw-toggle" class="pw-toggle" aria-label="Show password">
                <svg id="eye-icon" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  ${EYE_ON}
                </svg>
              </button>
            </div>
          </div>
          <div class="login-error" id="login-error"></div>
          <button type="submit" class="btn-primary">Sign in</button>
        </form>
      </div>
    </div>
  `;

  const pwInput = document.getElementById('password');
  const pwToggle = document.getElementById('pw-toggle');
  const eyeIcon = document.getElementById('eye-icon');

  pwToggle.addEventListener('click', () => {
    const visible = pwInput.type === 'text';
    pwInput.type = visible ? 'password' : 'text';
    eyeIcon.innerHTML = visible ? EYE_ON : EYE_OFF;
    pwToggle.setAttribute('aria-label', visible ? 'Show password' : 'Hide password');
  });

  const submitBtn = document.querySelector('#login-form button[type="submit"]');
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('login-error');
    errorEl.textContent = '';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in…';
    const password = pwInput.value;
    try {
      await login(password);
      window.location.hash = '#/';
    } catch (err) {
      errorEl.textContent = err.message || 'Login failed.';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign in';
    }
  });
}
