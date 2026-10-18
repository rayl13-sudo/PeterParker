// The frontend is a separate static deployment from the FastAPI backend.
// Local development uses the local API; deployed frontends use the Vercel API.
const localHostnames = new Set(["localhost", "127.0.0.1"]);

window.APP_CONFIG = {
  API_BASE_URL: localHostnames.has(window.location.hostname)
    ? "http://localhost:8000/api"
    : "https://peter-parker-eight.vercel.app/api",
    
};
