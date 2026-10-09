using Keepr.Ancs.App;

// keepr-ancs: logs live incoming iPhone notifications (Messages by default) received
// over Bluetooth LE ANCS. stdout = JSON lines (see Keepr.Ancs.OutputLines).
// BACKLOG-3839 spike; no Electron integration yet.

var opts = Options.Parse(args, out var argError);
if (opts is null)
{
    Console.Error.WriteLine(argError);
    return 2;
}

var emitter = new Emitter(opts.Pretty);
using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) =>
{
    e.Cancel = true;
    cts.Cancel();
};

try
{
    var session = new AncsSession(opts, emitter);

    if (opts.ListOnly)
    {
        emitter.Status("searching", "listing paired devices (--list)");
        await session.FindDeviceAsync();
        return 0;
    }

    while (!cts.IsCancellationRequested)
    {
        emitter.Status("searching");
        var info = await session.FindDeviceAsync();
        if (info is not null)
        {
            emitter.Status("searching", "selected", $"{info.Name} | {info.Id}");
            await session.RunAsync(info, cts.Token);
        }
        if (cts.IsCancellationRequested) break;

        emitter.Status("disconnected", $"retrying in {opts.RetrySeconds}s");
        try { await Task.Delay(TimeSpan.FromSeconds(opts.RetrySeconds), cts.Token); }
        catch (OperationCanceledException) { break; }
    }

    emitter.Status("disconnected", "stopped");
    return 0;
}
catch (Exception ex)
{
    // Last-resort net: every failure path must still be one JSON error line.
    emitter.Error("fatal", ex);
    return 1;
}
