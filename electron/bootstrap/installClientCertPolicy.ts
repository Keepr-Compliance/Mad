/**
 * BACKLOG-4052: client-certificate requests that come from no window (newer
 * Electron raises `select-client-certificate` with a null webContents for
 * requests made outside a page) get no certificate, instead of Electron's
 * default of picking the first one. Requests from a window keep the default.
 */
import { app } from "electron";

type CertCallback = (certificate?: Electron.Certificate) => void;

export function handleSelectClientCertificate(
  event: { preventDefault: () => void },
  webContents: unknown,
  callback: CertCallback,
): void {
  if (webContents) return;
  event.preventDefault();
  callback();
}

app.on("select-client-certificate", (event, webContents, _url, _list, callback) =>
  handleSelectClientCertificate(event, webContents, callback),
);
