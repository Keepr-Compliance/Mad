using System.Buffers.Binary;

namespace Keepr.Ancs;

/// <summary>
/// One GATT notification from the Notification Source characteristic.
///
/// ANCS spec, section "Notification Source", figure "Format of GATT notifications
/// delivered by the Notification Source characteristic" -- exactly 8 bytes:
///   [0]    EventID         (uint8)
///   [1]    EventFlags      (uint8, bitmask)
///   [2]    CategoryID      (uint8)
///   [3]    CategoryCount   (uint8)
///   [4..7] NotificationUID (uint32, little-endian; all ANCS integers are LE)
/// </summary>
public sealed record NotificationSourceEvent(
    AncsEventId EventId,
    AncsEventFlags Flags,
    AncsCategoryId CategoryId,
    byte CategoryCount,
    uint NotificationUid)
{
    public const int Length = 8;

    public bool IsPreExisting => (Flags & AncsEventFlags.PreExisting) != 0;
    public bool IsSilent => (Flags & AncsEventFlags.Silent) != 0;

    /// <summary>Returns null and sets <paramref name="error"/> when the buffer is malformed.</summary>
    public static NotificationSourceEvent? TryParse(ReadOnlySpan<byte> data, out string? error)
    {
        if (data.Length < Length)
        {
            error = $"Notification Source payload is {data.Length} bytes; expected {Length}";
            return null;
        }
        error = data.Length > Length
            ? $"Notification Source payload is {data.Length} bytes; expected {Length} (extra bytes ignored)"
            : null;

        return new NotificationSourceEvent(
            (AncsEventId)data[0],
            (AncsEventFlags)data[1],
            (AncsCategoryId)data[2],
            data[3],
            BinaryPrimitives.ReadUInt32LittleEndian(data.Slice(4, 4)));
    }
}
