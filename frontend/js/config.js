// Runtime config. Override API_BASE_URL per environment.
// When the backend serves the page (http://localhost:8000) the API is same-origin.
// Anywhere else (another dev server, a different port) talk to the backend directly.
window.APP_CONFIG = {
  API_BASE_URL: location.port === "8000" ? "/api" : "http://127.0.0.1:8000/api",
};
