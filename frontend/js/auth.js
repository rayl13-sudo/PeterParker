// "Remember Me" decides where the token lives:
//   checked   -> localStorage   (survives closing the browser)
//   unchecked -> sessionStorage (cleared when the tab/browser closes)
const KEY = "pp_token";

export function getToken() {
  return localStorage.getItem(KEY) || sessionStorage.getItem(KEY);
}

export function saveToken(token, remember) {
  clearToken();
  (remember ? localStorage : sessionStorage).setItem(KEY, token);
}

export function clearToken() {
  localStorage.removeItem(KEY);
  sessionStorage.removeItem(KEY);
}
