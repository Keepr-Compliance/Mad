namespace Keepr.Ancs.App;

internal sealed record Options(
    bool Pretty,
    bool AllApps,
    bool ListOnly,
    string? Device,
    ushort MessageMax,
    int RetrySeconds,
    int ResponseTimeoutSeconds)
{
    public const string Usage =
        "keepr-ancs [--pretty] [--all-apps] [--list] [--device <id or name substring>]\n" +
        "           [--max-message <1-65535, default 1000>] [--retry-seconds <n, default 5>]\n" +
        "           [--response-timeout <n, default 10>]";

    public static Options? Parse(string[] args, out string? error)
    {
        error = null;
        bool pretty = false, allApps = false, listOnly = false;
        string? device = null;
        ushort messageMax = 1000;
        int retry = 5, timeout = 10;

        for (var i = 0; i < args.Length; i++)
        {
            string? Next() => i + 1 < args.Length ? args[++i] : null;
            switch (args[i])
            {
                case "--pretty": pretty = true; break;
                case "--all-apps": allApps = true; break;
                case "--list": listOnly = true; break;
                case "--device":
                    device = Next();
                    if (string.IsNullOrWhiteSpace(device)) { error = "--device needs a value"; return null; }
                    break;
                case "--max-message":
                    if (!ushort.TryParse(Next(), out messageMax) || messageMax == 0)
                    { error = "--max-message must be 1-65535"; return null; }
                    break;
                case "--retry-seconds":
                    if (!int.TryParse(Next(), out retry) || retry < 1)
                    { error = "--retry-seconds must be >= 1"; return null; }
                    break;
                case "--response-timeout":
                    if (!int.TryParse(Next(), out timeout) || timeout < 1)
                    { error = "--response-timeout must be >= 1"; return null; }
                    break;
                case "-h":
                case "--help":
                    error = Usage; return null;
                default:
                    error = $"Unknown argument '{args[i]}'\n{Usage}"; return null;
            }
        }
        return new Options(pretty, allApps, listOnly, device, messageMax, retry, timeout);
    }
}
