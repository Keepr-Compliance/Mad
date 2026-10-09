using System.Buffers.Binary;
using System.Text;

namespace Keepr.Ancs;

/// <summary>A fully reassembled Get Notification Attributes response.</summary>
public sealed record NotificationAttributesResponse(
    uint NotificationUid,
    IReadOnlyDictionary<AncsNotificationAttributeId, string> Attributes)
{
    public string? Get(AncsNotificationAttributeId id) =>
        Attributes.TryGetValue(id, out var v) ? v : null;
}

public enum AssemblerResult
{
    /// <summary>More fragments are needed.</summary>
    Incomplete,
    /// <summary>Every requested attribute was parsed; see <see cref="DataSourceAssembler.Completed"/>.</summary>
    Complete,
    /// <summary>The bytes do not match the outstanding request; see <see cref="DataSourceAssembler.Error"/>.</summary>
    Error,
}

/// <summary>
/// Reassembles Data Source GATT notifications into one response.
///
/// ANCS spec, section "Get Notification Attributes", figure "Format of a response
/// to a Get Notification Attributes command":
///   CommandID (uint8) = 0
///   NotificationUID (uint32 LE)
///   AttributeList: repeated { AttributeID (uint8), AttributeLength (uint16 LE), Attribute (UTF-8, no NUL) }
///
/// ANCS spec, section "Control Point and Data Source": a response larger than the
/// ATT MTU is split across several Data Source notifications, and "the NC must
/// reassemble the response" -- it is complete once every requested attribute has
/// been received. The spec does not mark fragment boundaries, so only ONE request
/// may be outstanding at a time; the caller serialises requests.
///
/// The parser does NOT assume attributes come back in request order; it counts
/// distinct requested ids received.
/// </summary>
public sealed class DataSourceAssembler
{
    private readonly List<byte> _buffer = new();
    private uint _uid;
    private HashSet<AncsNotificationAttributeId> _expected = new();
    private bool _active;

    public NotificationAttributesResponse? Completed { get; private set; }
    public string? Error { get; private set; }
    public bool IsActive => _active;
    public uint ExpectedUid => _uid;

    /// <summary>Start waiting for the response to a request just written to the Control Point.</summary>
    public void Begin(uint notificationUid, IEnumerable<AttributeRequest> requested)
    {
        _buffer.Clear();
        _uid = notificationUid;
        _expected = new HashSet<AncsNotificationAttributeId>(requested.Select(r => r.Id));
        _active = true;
        Completed = null;
        Error = null;
    }

    public void Reset()
    {
        _buffer.Clear();
        _active = false;
    }

    public AssemblerResult Append(ReadOnlySpan<byte> fragment)
    {
        if (!_active)
        {
            Error = $"Data Source fragment of {fragment.Length} bytes arrived with no request outstanding";
            return AssemblerResult.Error;
        }

        foreach (var b in fragment) _buffer.Add(b);
        return TryParse();
    }

    private AssemblerResult TryParse()
    {
        var data = _buffer.ToArray().AsSpan();
        if (data.Length < 5) return AssemblerResult.Incomplete;

        if (data[0] != (byte)AncsCommandId.GetNotificationAttributes)
            return Fail($"Data Source response CommandID {data[0]}; expected 0");

        var uid = BinaryPrimitives.ReadUInt32LittleEndian(data.Slice(1, 4));
        if (uid != _uid)
            return Fail($"Data Source response for UID {uid}; expected {_uid}");

        var attrs = new Dictionary<AncsNotificationAttributeId, string>();
        var pos = 5;
        while (attrs.Count < _expected.Count)
        {
            if (data.Length - pos < 3) return AssemblerResult.Incomplete;
            var id = (AncsNotificationAttributeId)data[pos];
            var len = BinaryPrimitives.ReadUInt16LittleEndian(data.Slice(pos + 1, 2));
            if (data.Length - pos - 3 < len) return AssemblerResult.Incomplete;

            if (!_expected.Contains(id))
                return Fail($"Data Source response contains unrequested attribute {(byte)id}");

            attrs[id] = Encoding.UTF8.GetString(data.Slice(pos + 3, len));
            pos += 3 + len;
        }

        if (pos != data.Length)
            return Fail($"Data Source response has {data.Length - pos} trailing bytes after all requested attributes");

        Completed = new NotificationAttributesResponse(_uid, attrs);
        Reset();
        return AssemblerResult.Complete;
    }

    private AssemblerResult Fail(string message)
    {
        Error = message;
        Reset();
        return AssemblerResult.Error;
    }
}
