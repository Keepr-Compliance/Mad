/**
 * Side-effect bootstrap (BACKLOG-3799): every axios request made by the main
 * process goes over Electron net.fetch (Chromium TLS + OS certificate store),
 * not Node's TLS. Imported from main.ts before any handler is registered.
 * See services/mainNetFetch.ts for why.
 */
import { installMainNetAxios } from "../services/mainNetFetch";

installMainNetAxios();
