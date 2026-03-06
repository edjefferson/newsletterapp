import { Preferences } from '@capacitor/preferences';

export const SERVER_URL = import.meta.env.VITE_SERVER_URL || '';

export async function getToken() {
  const { value } = await Preferences.get({ key: 'auth_token' });
  return value;
}

export async function setToken(token) {
  await Preferences.set({ key: 'auth_token', value: token });
}

export async function clearToken() {
  await Preferences.remove({ key: 'auth_token' });
}

export async function apiFetch(path, options = {}) {
  const token = await getToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(SERVER_URL + path, { headers, ...options });

  if (res.status === 401) {
    await clearToken();
    window.location.hash = '#/login';
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text}`);
  }
  return res.json();
}

export async function login(password) {
  let res;
  try {
    res = await fetch(SERVER_URL + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
  } catch (err) {
    throw new Error(`Network error: ${err.message}`);
  }
  if (res.status === 401) throw new Error('Wrong password.');
  if (!res.ok) throw new Error(`Server error (${res.status})`);
  const data = await res.json();
  await setToken(data.token);
}
