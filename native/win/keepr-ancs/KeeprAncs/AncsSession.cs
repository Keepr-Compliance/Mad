using System.Threading.Channels;
using Keepr.Ancs;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Devices.Enumeration;
using Windows.Foundation;
using Windows.Security.Cryptography;
using Windows.Storage.Streams;

namespace Keepr.Ancs.App;

/// <summary>
/// One connect -> subscribe -> listen cycle against a paired iPhone. Returns when the
/// device disconnects, a stage fails, or the token is cancelled; the caller retries.
///
/// Every failure emits exactly one {"type":"error"} line naming the stage. Stage names
/// are deliberately fine-grained: the spike's question (MECHANISM UNTRACED in
/// BACKLOG-3839) is whether a third-party WinRT app can act as an ANCS client at all,
/// and a negative answer is only useful if it names where it stopped.
/// </summary>
internal sealed class AncsSession
{
    private readonly Options _opts;
    private readonly Emitter _out;
    private readonly DataSourceAssembler _assembler = new();
    private readonly object _assemblerLock = new();
    private TaskCompletionSource<NotificationAttributesResponse>? _pending;

    public AncsSession(Options opts, Emitter emitter)
    {
        _opts = opts;
        _out = emitter;
    }

    // ---------- device discovery ----------

    /// <summary>Lists paired devices as status lines and returns the selected LE device, or null.</summary>
    public async Task<DeviceInformation?> FindDeviceAsync()
    {
        IReadOnlyList<DeviceInformation> le;
        try
        {
            le = await DeviceInformation.FindAllAsync(
                BluetoothLEDevice.GetDeviceSelectorFromPairingState(true));
        }
        catch (Exception ex) { _out.Error("enumerate-devices", ex); return null; }

        foreach (var d in le)
            _out.Status("searching", $"candidate (LE, paired): {d.Name}", d.Id);

        // Diagnosis only: an iPhone paired from Settings may appear as a Classic device
        // with no LE entry. If so, ANCS (which is LE-only) cannot be reached via that pairing.
        try
        {
            var classic = await DeviceInformation.FindAllAsync(
                BluetoothDevice.GetDeviceSelectorFromPairingState(true));
            foreach (var d in classic)
                _out.Status("searching", $"paired Classic device (not usable for ANCS): {d.Name}", d.Id);
        }
        catch (Exception ex) { _out.Error("enumerate-classic-devices", ex); }

        if (le.Count == 0)
        {
            _out.Error("select-device", "No paired Bluetooth LE devices found. Pair the iPhone in Windows Settings > Bluetooth & devices.");
            return null;
        }

        if (_opts.Device is { } want)
        {
            var match = le.FirstOrDefault(d => string.Equals(d.Id, want, StringComparison.OrdinalIgnoreCase))
                ?? le.FirstOrDefault(d => d.Name.Contains(want, StringComparison.OrdinalIgnoreCase));
            if (match is null)
                _out.Error("select-device", $"No paired LE device matches --device '{want}'.");
            return match;
        }

        var phones = le.Where(d => d.Name.Contains("iPhone", StringComparison.OrdinalIgnoreCase)).ToList();
        if (phones.Count == 1) return phones[0];
        if (le.Count == 1) return le[0];

        _out.Error("select-device",
            $"{(phones.Count > 1 ? phones.Count : le.Count)} candidate devices; pass --device <id or name substring>.");
        return null;
    }

    // ---------- one session ----------

    public async Task RunAsync(DeviceInformation info, CancellationToken ct)
    {
        BluetoothLEDevice? device = null;
        GattSession? gattSession = null;
        GattDeviceService? service = null;
        GattCharacteristic? notificationSource = null, controlPoint = null, dataSource = null;
        var disconnected = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var events = Channel.CreateUnbounded<NotificationSourceEvent>(
            new UnboundedChannelOptions { SingleReader = true });

        TypedEventHandler<BluetoothLEDevice, object>? onConn = null;
        TypedEventHandler<GattCharacteristic, GattValueChangedEventArgs>? onNs = null, onDs = null;

        try
        {
            // connect
            try { device = await BluetoothLEDevice.FromIdAsync(info.Id); }
            catch (Exception ex) { _out.Error("connect", ex); return; }
            if (device is null) { _out.Error("connect", $"BluetoothLEDevice.FromIdAsync returned null for '{info.Name}'"); return; }

            onConn = (d, _) =>
            {
                var st = d.ConnectionStatus;
                _out.Status(st == BluetoothConnectionStatus.Connected ? "connected" : "disconnected",
                    $"ConnectionStatus={st}", d.Name);
                if (st == BluetoothConnectionStatus.Disconnected) disconnected.TrySetResult();
            };
            device.ConnectionStatusChanged += onConn;

            // keep the link up while we listen (non-fatal if unavailable)
            try
            {
                gattSession = await GattSession.FromDeviceIdAsync(device.BluetoothDeviceId);
                if (gattSession is not null) gattSession.MaintainConnection = true;
            }
            catch (Exception ex) { _out.Error("gatt-session", ex); }

            // ANCS service
            GattDeviceServicesResult svc;
            try { svc = await device.GetGattServicesForUuidAsync(AncsUuids.Service, BluetoothCacheMode.Uncached); }
            catch (Exception ex) { _out.Error("get-ancs-service", ex); return; }
            if (svc.Status != GattCommunicationStatus.Success)
            {
                _out.Error("get-ancs-service", "GetGattServicesForUuidAsync failed", svc.Status.ToString(), svc.ProtocolError);
                return;
            }
            if (svc.Services.Count == 0)
            {
                _out.Error("get-ancs-service",
                    "ANCS service not exposed by the device. On the iPhone: Settings > Bluetooth > (this PC) > Share System Notifications ON.",
                    svc.Status.ToString());
                return;
            }
            service = svc.Services[0];

            // access + open
            try
            {
                var access = await service.RequestAccessAsync();
                if (access != DeviceAccessStatus.Allowed)
                {
                    _out.Error("service-access", $"RequestAccessAsync returned {access}");
                    return;
                }
            }
            catch (Exception ex) { _out.Error("service-access", ex); return; }

            try
            {
                var open = await service.OpenAsync(GattSharingMode.SharedReadAndWrite);
                if (open is not (GattOpenStatus.Success or GattOpenStatus.AlreadyOpened))
                    _out.Error("service-open", $"OpenAsync returned {open} (continuing)");
            }
            catch (Exception ex) { _out.Error("service-open", ex); }

            // characteristics
            notificationSource = await GetCharacteristicAsync(service, AncsUuids.NotificationSource, "notification-source");
            controlPoint = await GetCharacteristicAsync(service, AncsUuids.ControlPoint, "control-point");
            dataSource = await GetCharacteristicAsync(service, AncsUuids.DataSource, "data-source");
            if (notificationSource is null || controlPoint is null || dataSource is null) return;

            onDs = (_, args) => OnDataSource(ReadBuffer(args.CharacteristicValue));
            onNs = (_, args) => OnNotificationSource(ReadBuffer(args.CharacteristicValue), events.Writer);
            dataSource.ValueChanged += onDs;
            notificationSource.ValueChanged += onNs;

            // Data Source first, so responses have somewhere to land before the iPhone
            // starts sending (pre-existing) Notification Source events.
            if (!await SubscribeAsync(dataSource, "subscribe-data-source")) return;
            if (!await SubscribeAsync(notificationSource, "subscribe-notification-source")) return;

            _out.Status("connected", "subscribed to ANCS Notification Source and Data Source", device.Name);

            using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct);
            var worker = ProcessEventsAsync(events.Reader, controlPoint, linked.Token);

            await Task.WhenAny(disconnected.Task, Task.Delay(Timeout.Infinite, ct));
            linked.Cancel();
            try { await worker; } catch (OperationCanceledException) { }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (Exception ex)
        {
            _out.Error("session", ex);
        }
        finally
        {
            events.Writer.TryComplete();
            if (dataSource is not null && onDs is not null) dataSource.ValueChanged -= onDs;
            if (notificationSource is not null && onNs is not null) notificationSource.ValueChanged -= onNs;
            if (device is not null && onConn is not null) device.ConnectionStatusChanged -= onConn;
            lock (_assemblerLock) { _assembler.Reset(); _pending = null; }
            try { service?.Dispose(); } catch { /* best effort */ }
            try { gattSession?.Dispose(); } catch { /* best effort */ }
            try { device?.Dispose(); } catch { /* best effort */ }
        }
    }

    private async Task<GattCharacteristic?> GetCharacteristicAsync(GattDeviceService service, Guid uuid, string name)
    {
        var stage = $"get-characteristic-{name}";
        try
        {
            var r = await service.GetCharacteristicsForUuidAsync(uuid, BluetoothCacheMode.Uncached);
            if (r.Status != GattCommunicationStatus.Success)
            {
                _out.Error(stage, "GetCharacteristicsForUuidAsync failed", r.Status.ToString(), r.ProtocolError);
                return null;
            }
            if (r.Characteristics.Count == 0)
            {
                _out.Error(stage, $"Characteristic {uuid} not found", r.Status.ToString());
                return null;
            }
            return r.Characteristics[0];
        }
        catch (Exception ex) { _out.Error(stage, ex); return null; }
    }

    private async Task<bool> SubscribeAsync(GattCharacteristic c, string stage)
    {
        try
        {
            var r = await c.WriteClientCharacteristicConfigurationDescriptorWithResultAsync(
                GattClientCharacteristicConfigurationDescriptorValue.Notify);
            if (r.Status != GattCommunicationStatus.Success)
            {
                // ProtocolError 0x05 (Insufficient Authentication) / 0x0F (Insufficient Encryption)
                // here means the link is not bonded/encrypted, which iOS requires for ANCS.
                _out.Error(stage, "Writing the CCCD (Notify) failed", r.Status.ToString(), r.ProtocolError);
                return false;
            }
            return true;
        }
        catch (Exception ex) { _out.Error(stage, ex); return false; }
    }

    // ---------- event handling ----------

    private void OnNotificationSource(byte[] data, ChannelWriter<NotificationSourceEvent> writer)
    {
        try
        {
            var ev = NotificationSourceEvent.TryParse(data, out var err);
            if (err is not null) _out.Error("parse-notification-source", err);
            if (ev is null) return;
            if (ev.EventId != AncsEventId.NotificationAdded) return; // Modified/Removed: nothing to fetch
            writer.TryWrite(ev);
        }
        catch (Exception ex) { _out.Error("parse-notification-source", ex); }
    }

    private void OnDataSource(byte[] data)
    {
        try
        {
            lock (_assemblerLock)
            {
                var r = _assembler.Append(data);
                if (r == AssemblerResult.Complete && _assembler.Completed is { } done)
                    _pending?.TrySetResult(done);
                else if (r == AssemblerResult.Error)
                {
                    _out.Error("parse-data-source", _assembler.Error ?? "unknown Data Source parse error");
                    _pending?.TrySetCanceled();
                }
            }
        }
        catch (Exception ex) { _out.Error("parse-data-source", ex); }
    }

    /// <summary>
    /// Serialises Get Notification Attributes requests: one outstanding at a time,
    /// because Data Source fragments carry no boundary marker (see DataSourceAssembler).
    /// </summary>
    private async Task ProcessEventsAsync(ChannelReader<NotificationSourceEvent> reader,
        GattCharacteristic controlPoint, CancellationToken ct)
    {
        var requested = GetNotificationAttributesCommand.DefaultAttributes(_opts.MessageMax);

        await foreach (var ev in reader.ReadAllAsync(ct))
        {
            var tcs = new TaskCompletionSource<NotificationAttributesResponse>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            lock (_assemblerLock)
            {
                _pending = tcs;
                _assembler.Begin(ev.NotificationUid, requested);
            }

            try
            {
                var cmd = GetNotificationAttributesCommand.Build(ev.NotificationUid, requested);
                var w = await controlPoint.WriteValueWithResultAsync(
                    CryptographicBuffer.CreateFromByteArray(cmd), GattWriteOption.WriteWithResponse);
                if (w.Status != GattCommunicationStatus.Success)
                {
                    // 0xA0-0xA3 are ANCS Control Point errors (see AncsErrorCodes); 0xA3 is
                    // typical when the notification was dismissed before we asked.
                    _out.Error("write-control-point",
                        $"GetNotificationAttributes for UID {ev.NotificationUid} failed",
                        w.Status.ToString(), w.ProtocolError);
                    continue;
                }
            }
            catch (Exception ex)
            {
                _out.Error("write-control-point", ex);
                continue;
            }

            NotificationAttributesResponse resp;
            try
            {
                resp = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(_opts.ResponseTimeoutSeconds), ct);
            }
            catch (TimeoutException)
            {
                _out.Error("data-source-timeout",
                    $"No complete Data Source response for UID {ev.NotificationUid} within {_opts.ResponseTimeoutSeconds}s");
                continue;
            }
            catch (TaskCanceledException) when (!ct.IsCancellationRequested)
            {
                continue; // parse error already reported by OnDataSource
            }
            finally
            {
                lock (_assemblerLock)
                {
                    if (ReferenceEquals(_pending, tcs)) { _pending = null; _assembler.Reset(); }
                }
            }

            var app = resp.Get(AncsNotificationAttributeId.AppIdentifier);
            if (_opts.AllApps || app == AncsAppIds.MobileSms)
                _out.Message(ev, resp);
        }
    }

    private static byte[] ReadBuffer(IBuffer buffer)
    {
        if (buffer is null || buffer.Length == 0) return Array.Empty<byte>();
        CryptographicBuffer.CopyToByteArray(buffer, out var bytes);
        return bytes ?? Array.Empty<byte>();
    }
}
