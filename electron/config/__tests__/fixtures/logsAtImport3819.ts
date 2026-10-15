/**
 * BACKLOG-3819 fixture: a module that writes to electron-log while it is being
 * imported, the way installSentry / installNativeCapabilities / services do
 * before main.ts reaches its own logging setup.
 */
import log from "electron-log";

log.info("[Fixture] import-time line for jane.importtime@example.com at +15555550166");
