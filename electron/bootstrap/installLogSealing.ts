/**
 * BACKLOG-3819 — decide, once, whether this process seals its log files.
 *
 * Packaged (the installed app): electron-log's file transport is replaced by the
 * sealing one (config/sealedLogTransport.ts) before any module can write.
 * Unpackaged (dev): electron-log's own transport is left in place, so dev logs
 * are plaintext — still redacted by the hook in logFileConfig.ts, which is
 * installed for both. The decision is recorded on the sink module so the at-rest
 * "logs" job (atRest/startup.ts) follows the same one.
 *
 * Split out of installAppDataPaths.ts so both branches can be tested.
 */
import { installSealedFileTransport } from "../config/sealedLogTransport";
import { setAsideSealedLiveLog } from "../services/logScrub";
import { getLogSink, setLogSealingEnabled, type SealedLogSink } from "../services/sealedLogSink";
import { logsSealedAtRest } from "./appDataPaths";

interface LoggerWithFile {
  transports: Record<string, unknown>;
}

export interface InstallLogSealingOptions {
  isPackaged: boolean;
  sink?: SealedLogSink;
  /** Registers a callback for process exit / app quit (flushes held lines). */
  onExit?: (fn: () => void) => void;
}

/** Returns true when logs are sealed in this process. */
export function installLogSealing(logger: LoggerWithFile, opts: InstallLogSealingOptions): boolean {
  const seal = logsSealedAtRest({ isPackaged: opts.isPackaged });
  setLogSealingEnabled(seal);
  if (!seal) return false;
  const sink = opts.sink ?? getLogSink();
  installSealedFileTransport(logger, sink);
  opts.onExit?.(() => sink.flushAtExit());
  return true;
}

/**
 * Dev only, after the log path is final: a live log sealed by an earlier build is
 * moved aside so plaintext is never appended behind its header. Never throws.
 */
export function prepareDevLogFile(logger: LoggerWithFile): string | null {
  try {
    const file = (logger.transports.file as { getFile?: () => { path: string } } | undefined)?.getFile?.().path;
    return file ? setAsideSealedLiveLog(file) : null;
  } catch {
    return null;
  }
}
