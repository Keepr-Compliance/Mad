using Keepr.Ancs;

namespace Keepr.Ancs.App;

/// <summary>Thread-safe writer for the stdout JSON-lines contract (see OutputLines).</summary>
internal sealed class Emitter
{
    private readonly object _lock = new();
    private readonly bool _pretty;

    public Emitter(bool pretty)
    {
        _pretty = pretty;
        Console.OutputEncoding = System.Text.Encoding.UTF8;
    }

    public void Status(string state, string? detail = null, string? device = null) =>
        Write(OutputLines.Status(state, detail, device));

    public void Error(string stage, string message, string? gattStatus = null,
        byte? protocolError = null, int? hresult = null) =>
        Write(OutputLines.Error(stage, message, gattStatus, protocolError, hresult));

    public void Error(string stage, Exception ex) =>
        Error(stage, $"{ex.GetType().Name}: {ex.Message}", hresult: ex.HResult);

    public void Message(NotificationSourceEvent ev, NotificationAttributesResponse resp)
    {
        var rawDate = resp.Get(AncsNotificationAttributeId.Date);
        var ts = AncsDate.ToIso(rawDate) ?? rawDate;
        var sender = resp.Get(AncsNotificationAttributeId.Title);
        var body = resp.Get(AncsNotificationAttributeId.Message);

        if (_pretty)
        {
            var app = resp.Get(AncsNotificationAttributeId.AppIdentifier);
            var suffix = app == AncsAppIds.MobileSms ? "" : $"  ({app})";
            var pre = ev.IsPreExisting ? "  (pre-existing)" : "";
            Write(OutputLines.Pretty(ts, sender, body) + suffix + pre);
            return;
        }

        Write(OutputLines.Message(
            ts, sender, body,
            resp.Get(AncsNotificationAttributeId.AppIdentifier),
            ev.IsPreExisting, ev.NotificationUid,
            resp.Get(AncsNotificationAttributeId.Subtitle),
            ev.CategoryId.ToString(),
            DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")));
    }

    private void Write(string line)
    {
        lock (_lock)
        {
            Console.Out.WriteLine(line);
            Console.Out.Flush();
        }
    }
}
