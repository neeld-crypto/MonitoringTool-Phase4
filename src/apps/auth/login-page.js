const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The sign-in page: plain HTML and CSS (no script), so it works before anything else is allowed to load. */
export function loginPage({ error = '', next = '/' } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pulse – Sign in</title>
<link rel="icon" href="/favicon-32.png">
<style>
  :root { color-scheme: dark; --bg: #0d1117; --panel: #161b22; --line: #30363d; --text: #e6edf3; --muted: #8b949e; --accent: #2f81f7; --bad: #f85149; }
  @media (prefers-color-scheme: light) {
    :root { color-scheme: light; --bg: #f6f8fa; --panel: #ffffff; --line: #d0d7de; --text: #1f2328; --muted: #656d76; --accent: #0969da; --bad: #cf222e; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text); font: 15px/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
  form { width: 100%; max-width: 360px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 28px 24px; display: grid; gap: 14px; }
  .brand { display: flex; align-items: center; gap: 10px; justify-content: center; margin-bottom: 4px; }
  .brand img { height: 36px; width: auto; }
  .brand b { font-size: 22px; letter-spacing: 0.02em; }
  p { margin: 0; color: var(--muted); text-align: center; font-size: 13px; }
  label { display: grid; gap: 6px; font-size: 13px; color: var(--muted); }
  input { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; }
  input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  button { font: inherit; font-weight: 600; color: #fff; background: var(--accent); border: 0; border-radius: 6px; padding: 10px 12px; cursor: pointer; }
  button:hover { filter: brightness(1.1); }
  .error { color: var(--bad); font-size: 13px; text-align: center; }
</style>
</head>
<body>
<form method="post" action="/__auth/login">
  <div class="brand"><img src="/skandha-logo.png" alt="Skandha Media Services"><b>Pulse</b></div>
  <p>Sign in to open the monitoring wall.</p>
  ${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ''}
  <input type="hidden" name="next" value="${escapeHtml(next)}">
  <label>User name<input name="user" autocomplete="username" autofocus required></label>
  <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
  <button type="submit">Sign in</button>
</form>
</body>
</html>
`;
}
